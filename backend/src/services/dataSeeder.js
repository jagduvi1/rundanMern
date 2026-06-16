// DataSeeder — idempotent demo/sample data (port of
// Rundan.Server/Services/DataSeeder.cs).
//
// Seeds a starting day for SEED_ON_STARTUP: a pre-registered roster and one event
// ("Försommarspelen 2026") with the eight planned activities — a quiz walk,
// catching/throwing games, fastest-time and tallest-tower measured games, a
// closest-to-target timing game, a boule knockout and a word game. Teams are
// pre-generated (via the same PartnerMixer as runtime); results start empty so
// the host runs each activity during the day. No-op if any Event/Activity/User
// already exists.

const crypto = require('crypto');
const {
  User, Event, EventMember, Activity, Participant, Question,
} = require('../models');
const {
  ActivityType, ActivityStatus, EventScoring, ScoringMode, Measurement, ScoreEntryMode,
} = require('../constants/enums');
const { uniqueJoinCode } = require('../utils/joinCode');
const { makeTeams } = require('./teams');

// The global roster (mirrors DataSeeder.RosterNames).
const ROSTER_NAMES = ['Mallis', 'Palle', 'LillMonica', 'Jimmy BK', 'Maria', 'Björn', 'Malin', 'Calle'];

// ── Question builders (mirror DataSeeder.Mc / GeoMc) ──────────────────────────

// A multiple-choice question subdoc: sequential option Order 0,1,2; IsCorrect
// from the [text, correct] tuples.
function mc(order, text, options) {
  return {
    order,
    text,
    kind: 0, // QuestionKind.MultipleChoice
    points: 1,
    options: options.map(([t, correct], i) => ({ order: i, text: t, isCorrect: correct })),
  };
}

// A geo-tagged multiple-choice question (Tipspromenad) — adds lat/long + a 30 m
// radius to a base MC.
function geoMc(order, text, lat, lng, options) {
  return {
    ...mc(order, text, options),
    latitude: lat,
    longitude: lng,
    radiusMeters: 30,
  };
}

// Build the plain (un-persisted) field set for a new demo activity. `joinCode` is
// supplied by the caller (a unique code generated up front). Mirrors
// DataSeeder.NewActivity (ScoringMode defaults HigherWins; Started/Finished
// stamps follow the status).
function newActivity(eventId, order, type, title, joinCode, now, rules, status) {
  return {
    eventId,
    order,
    type,
    title,
    description: rules,
    joinCode,
    scoringMode: ScoringMode.HigherWins,
    status,
    createdUtc: now,
    startedUtc: status === ActivityStatus.Live || status === ActivityStatus.Finished ? now : null,
    finishedUtc: status === ActivityStatus.Finished ? now : null,
  };
}

/**
 * Seed the demo day if the store is empty. Idempotent: a no-op if any Event,
 * Activity, or User already exists.
 *
 * @returns {Promise<boolean>} true if it seeded; false if data already existed.
 */
async function seedIfEmpty() {
  const [hasEvents, hasActivities, hasUsers] = await Promise.all([
    Event.exists({}),
    Activity.exists({}),
    User.exists({}),
  ]);
  if (hasEvents || hasActivities || hasUsers) {
    return false;
  }

  const now = new Date();

  // 1) Global roster.
  const users = await User.insertMany(ROSTER_NAMES.map((name) => ({ name, createdUtc: now })));

  // 2) The day's event (teams of 2, placement scoring) with the whole roster.
  const ev = await Event.create({
    name: 'Försommarspelen 2026',
    description:
      'En dag med åtta grenar. Ni byter lagkamrat inför varje gren — varje grens '
      + 'placering ger poäng (1:a = antal lag) till båda i laget. Högsta individuella total vinner!',
    teamSize: 2,
    scoring: EventScoring.Placement,
    joinCode: await uniqueJoinCode([Activity, Event]),
    createdUtc: now,
  });

  await EventMember.insertMany(
    users.map((u) => ({
      eventId: ev._id,
      userId: u._id,
      token: crypto.randomUUID(),
      isAdmin: u.name === 'Palle', // Palle is a co-host (event admin) to demo the role
      addedUtc: now,
    })),
  );

  // Pre-generate the 8 join codes (unique across events + activities) before
  // building docs. uniqueJoinCode checks the DB each time; generate sequentially.
  const codes = [];
  for (let i = 0; i < 8; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    codes.push(await uniqueJoinCode([Activity, Event]));
  }

  const activityDocs = [];

  // 1 — Poängpromenad (runs all day): 10 questions (1·X·2), random order.
  const walk = newActivity(
    ev._id, 1, ActivityType.Tipspromenad, 'Poängpromenad', codes[0], now,
    'Pågår under hela dagen. Start i Husvik – avslut vid Utkiken. 1 poäng för varje rätt svar.',
    ActivityStatus.Live,
  );
  walk.randomizeQuestions = true;
  walk.isPublic = true; // reusable from the library
  const walkQuestions = [
    geoMc(1, 'Sveriges största sjö?', 59.3250, 18.1000, [['Vänern', true], ['Vättern', false], ['Mälaren', false]]),
    geoMc(2, 'Hur många kommuner har Sverige?', 59.3256, 18.1012, [['90', false], ['290', true], ['490', false]]),
    geoMc(3, 'Vilket är skärgårdens vanligaste träd?', 59.3262, 18.0994, [['Tall', true], ['Ek', false], ['Bok', false]]),
    geoMc(4, 'Vad heter Sveriges nationaldjur (inofficiellt)?', 59.3268, 18.1006, [['Räv', false], ['Älg', true], ['Igelkott', false]]),
    geoMc(5, 'Hur djup är Östersjön som mest (ca)?', 59.3245, 18.1018, [['160 m', false], ['330 m', false], ['459 m', true]]),
    geoMc(6, 'Vilken färg får man av blått och gult?', 59.3239, 18.0998, [['Grön', true], ['Lila', false], ['Orange', false]]),
    geoMc(7, 'Vad används en eka till?', 59.3271, 18.0985, [['Ro', true], ['Flyga', false], ['Gräva', false]]),
    geoMc(8, 'Vilket år firade Sverige 500 år som nation? (ca)', 59.3233, 18.1024, [['1923', false], ['2023', true], ['1523-firande', false]]),
    geoMc(9, 'Hur många ben har en spindel?', 59.3277, 18.1003, [['6', false], ['8', true], ['10', false]]),
    geoMc(10, 'Vad heter Pippis häst?', 59.3228, 18.0991, [['Lilla Gubben', true], ['Herr Nilsson', false], ['Blixten', false]]),
  ];

  // 2 — Marshmallowfångst: 1 p per caught marshmallow (15 per par).
  const marsh = newActivity(
    ev._id, 2, ActivityType.ScoreGame, 'Marshmallowfångst', codes[1], now,
    'Fånga så många marshmallows som möjligt i en skål eller kastrull. En person sitter med ryggen '
    + 'mot kastaren som slungar marshmallows över axeln/huvudet. 15 marshmallows per par, 1 p per fångad.',
    ActivityStatus.Open,
  );
  marsh.scoreEntryMode = ScoreEntryMode.PerPlayer; // each catcher's catches add to the team
  marsh.isPublic = true; // reusable from the library

  // 3 — Skala potatis: fastest time wins.
  const potato = newActivity(
    ev._id, 3, ActivityType.ScoreGame, 'Skala potatis', codes[2], now,
    'Två och två – skala en potatis så snabbt som möjligt. En person håller potatisen, den andra '
    + 'skalar. Varje person får bara använda en hand. Kortast tid vinner.',
    ActivityStatus.Open,
  );
  potato.measurement = Measurement.TimeSeconds;
  potato.scoringMode = ScoringMode.LowerWins;

  // 4 — Boule (knockout): placement decides points.
  const boule = newActivity(
    ev._id, 4, ActivityType.Boule, 'Boule – utslagsspel', codes[3], now,
    'Lagen möts i en utslagstävling. Appen lottar matcherna. Vinnarna går vidare till nästa omgång '
    + 'och en final; förlorarna lottas in i ett förlorarträd. Placeringen avgör poängen.',
    ActivityStatus.Open,
  );
  boule.courtLabel = 'Bana';
  boule.courts = [
    { order: 1, name: 'Bana 1' },
    { order: 2, name: 'Bana 2' },
  ];

  // 5 — Bygga högst torn: tallest (mm) wins.
  const tower = newActivity(
    ev._id, 5, ActivityType.ScoreGame, 'Bygga högst torn', codes[4], now,
    'Bygg det högsta tornet du kan på 4 minuter av saker du hittar utomhus. När tiden är ute: släpp '
    + 'tornet och mät med tumstock. Högst torn vinner.',
    ActivityStatus.Open,
  );
  tower.measurement = Measurement.Millimetres;
  tower.scoringMode = ScoringMode.HigherWins;

  // 6 — Cornhole Flight: sum of throws (rings worth 1/2/3).
  const corn = newActivity(
    ev._id, 6, ActivityType.ScoreGame, 'Cornhole Flight', codes[5], now,
    'Kasta påsar i ringar gjorda av snöre på olika avstånd. Ringarna är märkta 1, 2 eller 3 poäng '
    + 'beroende på avstånd. Plussa ihop poängen från kasten.',
    ActivityStatus.Open,
  );
  corn.scoreEntryMode = ScoreEntryMode.PerPlayer;

  // 7 — Gå ur ringen i rätt tid: closest to 2:27 (147 s).
  const ring = newActivity(
    ev._id, 7, ActivityType.ScoreGame, 'Gå ur ringen i rätt tid', codes[6], now,
    'Lämna ringen så nära 2 min 27 sek som möjligt. Gå in i ringen när aktiviteten startar och kliv '
    + 'ut när du tror att exakt 2:27 har gått. Ingen klocka tillåten – känn på dig! Närmast rätt tid vinner.',
    ActivityStatus.Open,
  );
  ring.measurement = Measurement.TimeSeconds;
  ring.scoringMode = ScoringMode.ClosestToTarget;
  ring.targetValue = 147; // 2:27

  // 8 — Ordbygge med lappar: longest word wins.
  const words = newActivity(
    ev._id, 8, ActivityType.WordGame, 'Ordbygge med lappar', codes[7], now,
    'Bilda så långt ord som möjligt på 60 sekunder. Appen lottar 20 bokstavslappar upp och ner; ni '
    + 'får vända upp 10 av dem. Längst ord vinner.',
    ActivityStatus.Open,
  );
  words.isPublic = true; // reusable from the library

  activityDocs.push(walk, marsh, potato, boule, tower, corn, ring, words);

  // Persist the activities, then attach the walk's questions (separate collection).
  const created = await Activity.insertMany(activityDocs);
  const createdWalk = created.find((a) => a.order === 1);
  await Question.insertMany(walkQuestions.map((q) => ({ ...q, activityId: createdWalk._id })));

  // Pre-generate reshuffled teams for every activity (no results yet — the host
  // runs them live). Uses the same pure PartnerMixer as runtime, seeded by the
  // activity order, over the roster ordered by name (matches TeamService).
  const rosterByName = users
    .slice()
    .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));

  const teamDocs = [];
  for (const activity of created) {
    const groups = makeTeams(rosterByName, ev.teamSize, activity.order);
    for (const group of groups) {
      teamDocs.push({
        activityId: activity._id,
        displayName: group.map((u) => u.name).join(' & '),
        isTeam: true,
        token: crypto.randomUUID(),
        joinedUtc: now,
        members: group.map((u) => ({ userId: u._id })),
      });
    }
  }
  await Participant.insertMany(teamDocs);

  console.log(`[dataSeeder] Seeded demo event "${ev.name}" with ${created.length} activities and ${users.length} roster users.`);
  return true;
}

module.exports = { seedIfEmpty };
