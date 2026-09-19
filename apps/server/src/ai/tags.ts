/**
 * The tag vocabulary.
 *
 * Tags are the hinge of the whole system: they are what let a destination we
 * have never seen be recognised as "the same kind of outing" as one in the
 * user's history. Both the heuristic parser and the Jev agent classify into
 * this *closed* list, so a model can never invent a tag that the engine then
 * has to reason about.
 */
export const TAG_KEYWORDS: Readonly<Record<string, readonly string[]>> = {
  academic: ["college", "school", "university", "campus", "class", "lecture", "exam", "study", "semester"],
  lab: ["lab", "laboratory", "practical", "experiment", "workshop"],
  work: ["office", "work", "shift", "meeting", "client", "standup"],
  project: ["hackathon", "hack", "project", "sprint", "build", "demo", "prototype"],
  event: ["event", "conference", "meetup", "fest", "function", "wedding", "ceremony"],
  sports: ["sports", "cricket", "football", "badminton", "tennis", "match", "practice", "coach"],
  gym: ["gym", "workout", "training", "fitness"],
  social: ["friend", "party", "dinner", "hangout", "birthday"],
  travel: ["trip", "flight", "airport", "station", "travel", "tour", "vacation", "train"],
  shopping: ["shop", "market", "mall", "groceries", "store"],
  medical: ["doctor", "hospital", "clinic", "dentist", "appointment", "checkup"],
  outdoor: ["park", "hike", "trek", "beach", "picnic", "camping"],
  errand: ["bank", "errand", "post office", "pick up", "drop"],
};

export const TAG_VOCABULARY: readonly string[] = Object.keys(TAG_KEYWORDS);

/**
 * Precise wording for each tag question, with explicit yes/no criteria.
 *
 * Measured, not guessed: with a bare "This outing involves: travel" prompt the
 * model scored `travel` at 0.79-0.80 for "heading to the gym" and "off to the
 * office for a standup". That is not model error — it is an ambiguous question,
 * because local errands genuinely are a form of going somewhere. Supplying a
 * false-case that excludes short local trips is what fixes it. Tuning the
 * acceptance threshold instead would have thrown away the legitimate signals
 * the model was getting right (`project` at 0.81 for a hackathon).
 */
export const TAG_GUIDANCE: Readonly<Record<string, { question: string; yes: string; no: string }>> =
  {
    academic: {
      question: "Is this outing for study, classes, or coursework?",
      yes: "Attending classes, lectures or exams, or studying",
      no: "Not related to study or coursework",
    },
    lab: {
      question: "Does this outing involve laboratory or practical workshop work?",
      yes: "A lab session, experiment, or hands-on practical class",
      no: "No laboratory or practical equipment is involved",
    },
    work: {
      question: "Is this outing for paid work or a job?",
      yes: "A workplace, office, shift or work meeting",
      no: "Not for employment",
    },
    project: {
      question: "Is this outing for building or shipping a project?",
      yes: "A hackathon, sprint, build session or demo",
      no: "Not a collaborative build or shipping session",
    },
    event: {
      question: "Is this outing for an organised event or gathering?",
      yes: "A conference, meetup, festival, ceremony or similar gathering",
      no: "No organised event is being attended",
    },
    sports: {
      question: "Does this outing involve playing a sport or a team practice?",
      yes: "A match, practice session or coaching for a sport",
      no: "No sport is being played",
    },
    gym: {
      question: "Is this outing specifically a gym or fitness workout?",
      yes: "A visit to a gym for exercise",
      no: "Not a gym workout",
    },
    social: {
      question: "Is the main point of this outing socialising with people?",
      yes: "Meeting friends, a party, dinner or a hangout",
      no: "The outing has a practical purpose rather than a social one",
    },
    travel: {
      question:
        "Is this a long journey — a flight, train, or an overnight stay away from home?",
      yes: "Travelling a long distance or staying away from home",
      no: "A short local trip near home, such as college, the gym, the office or a shop",
    },
    shopping: {
      question: "Is the purpose of this outing to buy things?",
      yes: "Visiting a shop, market or mall to purchase something",
      no: "Not primarily to buy goods",
    },
    medical: {
      question: "Is this outing for a medical appointment or treatment?",
      yes: "A doctor, dentist, hospital or clinic visit",
      no: "Not a medical visit",
    },
    outdoor: {
      question: "Is this outing for outdoor recreation in nature?",
      yes: "A hike, trek, beach trip, picnic or camping",
      no: "Not outdoor recreation in nature",
    },
    errand: {
      question: "Is this outing a short practical chore, like a bank or post office?",
      yes: "Running a specific errand such as banking or posting something",
      no: "Not a short practical errand",
    },
  };

/** Purposes offered to the classifier, so it picks rather than invents. */
export const KNOWN_PURPOSES: readonly string[] = [
  "lab",
  "class",
  "lecture",
  "exam",
  "work",
  "meeting",
  "hackathon",
  "project work",
  "sports practice",
  "gym",
  "dinner",
  "shopping",
  "doctor",
  "interview",
];

/** Tags inferred purely from keywords. Deterministic, and the fallback path. */
export function inferTags(rawInput: string): string[] {
  const text = rawInput.toLowerCase();
  const tags: string[] = [];
  for (const [tag, keywords] of Object.entries(TAG_KEYWORDS)) {
    if (keywords.some((keyword) => text.includes(keyword))) tags.push(tag);
  }
  return tags;
}

/**
 * Weather tags are added from a real forecast rather than inferred from text,
 * so they are kept out of the keyword vocabulary to avoid double-counting.
 */
export const WEATHER_CONDITION_TAGS: Readonly<Record<string, string>> = {
  rain: "rain",
  snow: "snow",
  clear: "",
};
