/**
 * DynamoDB setup for the deployed app.
 *
 *   CONTEXTPACK_TABLE=contextpack AWS_REGION=... npm run setup:aws
 *
 * Run it once, locally, with credentials that can create a table. It does the
 * three things that are easy to get wrong by hand:
 *
 *   1. creates the table if it does not exist (on-demand billing, so there is no
 *      provisioned capacity to pay for while nobody is using it),
 *   2. runs a real round trip through the *adapter* — not just a raw client call —
 *      so you find out now, not from a judge, whether writes and reads agree,
 *   3. prints the least-privilege IAM policy and the exact variables to paste into
 *      Vercel.
 *
 * It writes under a dedicated user id and deletes what it wrote, so running it
 * against a table that already holds a history cannot damage it.
 */
import {
  CreateTableCommand,
  DeleteItemCommand,
  DescribeTableCommand,
  DynamoDBClient,
  ResourceNotFoundException,
  type DynamoDBClientConfig,
} from "@aws-sdk/client-dynamodb";
import type { Trip, TripItem } from "@contextpack/shared";
import { loadEnvFile } from "../env";
import {
  createDynamoStore,
  type DynamoCommandClient,
  type DynamoStore,
} from "../store/dynamodb";

/**
 * The low-level DynamoDB client speaks AttributeValue maps (`{ S: "x" }`), while
 * the adapter speaks the document client's plain objects. Both reach the same
 * wire; the cast is the seam between the two shapes.
 */
const asAdapterClient = (client: DynamoDBClient): DynamoCommandClient =>
  client as unknown as DynamoCommandClient;

const CHECK_USER = "setup-check";
const DEFAULT_TABLE = "contextpack";

type Status = "ok" | "failed" | "warn";

function print(status: Status, name: string, detail = ""): void {
  const label = status === "ok" ? "PASS" : status === "warn" ? "WARN" : "FAIL";
  console.log(`[${label}] ${name}`);
  if (detail) console.log(`       ${detail}`);
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    const name = error.name;
    if (name === "UnrecognizedClientException" || name === "InvalidSignatureException") {
      return `${name}: the credentials were rejected. Check that the access key is active and matches the secret.`;
    }
    if (name === "AccessDeniedException") {
      return `${name}: these credentials cannot do that yet — the policy printed below is the one this script needs.`;
    }
    if (name === "ExpiredTokenException") {
      return `${name}: this session token has expired; get fresh credentials.`;
    }
    return `${name}: ${error.message}`;
  }
  return String(error);
}

async function ensureTable(
  client: DynamoDBClient,
  table: string,
): Promise<{ created: boolean; arn: string | null }> {
  try {
    const existing = await client.send(new DescribeTableCommand({ TableName: table }));
    print("ok", `table "${table}" already exists`, `status=${existing.Table?.TableStatus}`);
    return { created: false, arn: existing.Table?.TableArn ?? null };
  } catch (error) {
    if (!(error instanceof ResourceNotFoundException)) throw error;
  }

  print("warn", `table "${table}" not found — creating it`, "on-demand billing: no capacity to pay for while idle");
  await client.send(
    new CreateTableCommand({
      TableName: table,
      BillingMode: "PAY_PER_REQUEST",
      AttributeDefinitions: [{ AttributeName: "id", AttributeType: "S" }],
      KeySchema: [{ AttributeName: "id", KeyType: "HASH" }],
    }),
  );

  // Table creation is asynchronous; a read before ACTIVE fails with a confusing
  // ResourceNotFound, so wait rather than leaving the first real request to it.
  for (let attempt = 1; attempt <= 30; attempt += 1) {
    const described = await client.send(new DescribeTableCommand({ TableName: table }));
    if (described.Table?.TableStatus === "ACTIVE") {
      print("ok", `table "${table}" is ACTIVE`, `created in ~${attempt}s`);
      return { created: true, arn: described.Table.TableArn ?? null };
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  print("warn", "table is still not ACTIVE after 30s", "continuing anyway; retry this script if reads fail");
  return { created: true, arn: null };
}

const trip = (id: string): Trip => ({
  id,
  userId: CHECK_USER,
  rawInput: "setup check",
  context: { destination: "setup", tags: ["setup"] },
  startedAt: new Date().toISOString(),
});

const tripItem = (tripId: string): TripItem => ({
  tripId,
  itemId: "setup-item",
  predictedProbability: 0.5,
  userAction: "packed",
  confirmationSource: "confirmed",
});

/**
 * Exercise the adapter the app will actually use.
 *
 * The interesting property is not "can we write" but "does a *second* store
 * instance see what the first one wrote" — that is the difference between this
 * working and the deployed app failing with "Unknown trip", which is exactly what
 * the memory store did when the next request landed on another instance.
 */
async function roundTrip(store: DynamoStore, table: string, client: DynamoDBClient): Promise<boolean> {
  const tripId = `setup-${Date.now().toString(36)}`;

  try {
    await store.putTrip(trip(tripId));

    // A different instance, as a second serverless invocation would be.
    const second = createDynamoStore({ table, client: asAdapterClient(client) });
    const found = await second.getTrip(tripId);
    if (!found) {
      print(
        "failed",
        "a second instance could not read the trip",
        "this is the failure the adapter exists to fix",
      );
      return false;
    }
    print("ok", "a second instance reads what the first one wrote", `trip ${tripId}`);

    await second.putTripItem(tripItem(tripId));
    const items = await store.listTripItems(tripId);
    if (items.length !== 1) {
      print("failed", "the decision did not come back", `expected 1 item, got ${items.length}`);
      return false;
    }
    print("ok", "a decision round-trips", `${items[0]!.itemId} action=${items[0]!.userAction}`);

    const samples = await store.listSamples(CHECK_USER);
    if (!samples.some((sample) => sample.tripId === tripId)) {
      print("failed", "the trip is missing from the learning data", "predictions would never see it");
      return false;
    }
    print("ok", "learning can read the decision back", `${samples.length} sample(s) for ${CHECK_USER}`);

    return true;
  } finally {
    // Leave the table exactly as it was found. Only the two keys this check wrote
    // are removed, so running it against a real history cannot damage it.
    await client.send(
      new DeleteItemCommand({ TableName: table, Key: { id: { S: `user#${CHECK_USER}` } } }),
    );
    await client.send(
      new DeleteItemCommand({ TableName: table, Key: { id: { S: `trip#${tripId}` } } }),
    );
  }
}

function policyFor(table: string, arn: string | null): string {
  const resource = arn ?? `arn:aws:dynamodb:<region>:<account-id>:table/${table}`;
  return JSON.stringify(
    {
      Version: "2012-10-17",
      Statement: [
        {
          Effect: "Allow",
          Action: [
            "dynamodb:GetItem",
            "dynamodb:PutItem",
            "dynamodb:DeleteItem",
            "dynamodb:Scan",
            "dynamodb:DescribeTable",
          ],
          Resource: resource,
        },
      ],
    },
    null,
    2,
  );
}

async function main(): Promise<void> {
  const env = loadEnvFile();
  const table = process.env.CONTEXTPACK_TABLE?.trim() || DEFAULT_TABLE;
  const region = process.env.AWS_REGION?.trim() || process.env.AWS_DEFAULT_REGION?.trim();
  const endpoint = process.env.CONTEXTPACK_DYNAMODB_ENDPOINT?.trim();

  console.log("ContextPack DynamoDB setup");
  console.log("==========================");
  console.log(`env file    ${env.files.length > 0 ? env.files.join(", ") : "(none — using the shell only)"}`);
  console.log(`table       ${table}`);
  console.log(`region      ${region ?? "(unset — the SDK will try AWS_REGION, then ~/.aws/config)"}`);
  console.log(`endpoint    ${endpoint ?? "(AWS)"}`);
  const queuedKey = process.env.AWS_ACCESS_KEY_ID?.trim();
  console.log(
    `credentials ${queuedKey ? "from AWS_ACCESS_KEY_ID in the environment" : "not in the environment — the SDK will look in ~/.aws or for a role"}`,
  );
  console.log("");

  const config: DynamoDBClientConfig = {};
  if (region) config.region = region;
  if (endpoint) config.endpoint = endpoint;
  const client = new DynamoDBClient(config);

  let arn: string | null = null;
  try {
    const tableState = await ensureTable(client, table);
    arn = tableState.arn;
  } catch (error) {
    print("failed", "could not reach DynamoDB", describeError(error));
    console.log(
      "\nBefore retrying: the account needs an access key with permission to describe and create\n" +
        "tables, and AWS_REGION set to the region you want the table in.",
    );
    process.exitCode = 1;
    return;
  }

  console.log("");
  const store = createDynamoStore({ table, client: asAdapterClient(client) });
  let healthy = false;
  try {
    healthy = await roundTrip(store, table, client);
  } catch (error) {
    print("failed", "the round trip threw", describeError(error));
  }

  console.log("");
  console.log("What to put in Vercel (Settings → Environment Variables)");
  console.log("======================================================");
  console.log(`CONTEXTPACK_STORE   dynamodb`);
  console.log(`CONTEXTPACK_TABLE   ${table}`);
  console.log(`AWS_REGION          ${region ?? "<your region, e.g. ap-south-1>"}`);
  console.log(`AWS_ACCESS_KEY_ID   <the access key id>`);
  console.log(`AWS_SECRET_ACCESS_KEY  <the secret>`);
  console.log("\nSet them for Production, then redeploy — variables only reach new deployments.");

  console.log("\nLeast-privilege policy for that key");
  console.log("===================================");
  console.log(policyFor(table, arn));

  console.log("");
  if (healthy) {
    console.log("The table is ready. To give the deployed app a learned history to demo:");
    console.log(
      `  CONTEXTPACK_STORE=dynamodb CONTEXTPACK_TABLE=${table} AWS_REGION=${region ?? "<region>"} npm run seed -w @contextpack/server`,
    );
    console.log("\nKeep the credentials out of the repo: they belong in your shell and in Vercel, nowhere else.");
  } else {
    console.log("Round trip did not complete — fix the failure above before deploying.");
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error("setup crashed:", error);
  process.exitCode = 1;
});
