// Display helpers — the React port of rundan's Services/Fmt.cs, translated to the
// app's Swedish UI. Score formatting, rich-text rendering, distance, the
// auto-generated rules summary, the per-type label, and the slap blurbs. Reused by
// Events / Event / Activity / Manage / Diploma so the copy stays consistent.
import {
  ActivityType, MatchFormat, Measurement, ScoringMode, ScoreEntryMode, SlapMode,
} from '../config/enums';

// Whole numbers plain; fractions to ≤2 dp. Mirrors Fmt.Num (invariant culture).
export function num(v) {
  const n = Number(v) || 0;
  if (n % 1 === 0) return String(Math.trunc(n));
  return n.toFixed(2).replace(/\.?0+$/, '');
}

// Rich-text "rules/info": new content is already sanitised HTML; legacy plain
// text is line-broken. Wrap the result in an element with the .rte-content class
// and dangerouslySetInnerHTML. NOTE: the server is the sanitizer — do not trust
// this client-side. Returns an object ready to spread into dangerouslySetInnerHTML.
export function richHtml(text) {
  if (!text || !text.trim()) return { __html: '' };
  if (text.includes('<')) return { __html: text };
  const escaped = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\n/g, '<br>');
  return { __html: escaped };
}

// ≥1000 m → "1.2 km", else "{m} m". Mirrors FormatDistance.
export function formatDistance(meters) {
  const m = Number(meters) || 0;
  return m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${m} m`;
}

// Human label for an activity type (Swedish; Boule shown as "Turnering").
export function typeLabel(type) {
  switch (type) {
    case ActivityType.Quiz: return 'Quiz';
    case ActivityType.Tipspromenad: return 'Tipspromenad';
    case ActivityType.Boule: return 'Turnering (utslagning)';
    case ActivityType.ScoreGame: return 'Poängspel';
    case ActivityType.WordGame: return 'Ordspel';
    case ActivityType.MapPin: return 'Kartnål';
    case ActivityType.MusicQuiz: return 'Musikquiz';
    case ActivityType.Memory: return 'Memory';
    default: return String(type);
  }
}

// The per-mode slap blurb shown on Events / Event ("Efter varje aktivitet …").
export function slapBlurb(mode) {
  switch (mode) {
    case SlapMode.Vanish:
      return 'kan vinnaren nypa en rival och halvera deras ledning — de poängen försvinner.';
    case SlapMode.SendToPlayer:
      return 'kan vinnaren nypa en rival och halvera deras ledning — och ge poängen till någon.';
    case SlapMode.SlappedSends:
      return 'kan vinnaren nypa en rival och halvera deras ledning — sedan skickar den nypta poängen vidare.';
    case SlapMode.Random:
      return 'kan vinnaren nypa en rival och halvera deras ledning — poängen försvinner eller skickas vidare (slumpat).';
    default:
      return '';
  }
}

// A short, auto-generated summary of how an activity is played and scored.
export function rulesSummary(a) {
  if (!a) return [];
  const lines = [];
  switch (a.type) {
    case ActivityType.Tipspromenad:
      lines.push('Gå rundan och svara på varje stations fråga när du kommer fram.');
      if (a.randomizeQuestions) lines.push('Stationerna kommer i slumpad ordning per lag.');
      lines.push('Ert lag svarar tillsammans — varje rätt svar ger frågans poäng.');
      break;
    case ActivityType.Quiz:
      lines.push('Svara på varje fråga i tur och ordning.');
      if (a.randomizeQuestions) lines.push('Frågorna kommer i slumpad ordning per lag.');
      lines.push('Ert lag svarar tillsammans — varje rätt svar ger frågans poäng.');
      break;
    case ActivityType.Boule:
      lines.push('Utslagsturnering: vinn din match för att klättra på vinnarsidan; förlorarna i första omgången spelar en förlorarsida.');
      lines.push(a.matchFormat === MatchFormat.Sets
        ? `Varje match är bäst av ${a.bestOfSets} set — först till ${a.gamesToWinSet} tar ett set, och flest set vinner.`
        : 'Varje match är ett enda game — högst poäng vinner.');
      lines.push('Poäng: 3 poäng för varje vinst på vinnarsidan, 1 poäng för varje vinst på förlorarsidan.');
      break;
    case ActivityType.WordGame:
      lines.push('Vänd på några av de nedåtvända bokstavsbrickorna och bygg det längsta ord du kan av dem.');
      lines.push('Din poäng är längden på ditt ord.');
      break;
    case ActivityType.MapPin:
      lines.push(`Ni får ${a.mapCityCount ?? 5} städer att placera på en karta utan ortnamn.`);
      lines.push('Sätt en nål där du tror staden ligger — avståndet till rätt plats är din poäng.');
      lines.push('Lägst total sträcka över alla städer vinner.');
      break;
    case ActivityType.MusicQuiz:
      lines.push('Värden spelar ett spår för varje fråga — namnge låten och artisten.');
      lines.push('Varje rätt gissning (låt och artist) ger spårets poäng; nära stavningar godtas.');
      break;
    case ActivityType.Memory:
      lines.push('Vänd kort två i taget för att hitta paren — ert lag har sin egen blandade bräda.');
      lines.push(a.measuresTime
        ? 'Töm brädan så snabbt du kan — snabbast tid vinner.'
        : 'Töm brädan på så få vändningar som möjligt — färst vändningar vinner.');
      break;
    default: { // ScoreGame + any future round game
      const measure = a.measurement === Measurement.TimeSeconds ? 'en tid'
        : a.measurement === Measurement.Millimetres ? 'en längd'
          : 'poäng';
      const win = a.scoringMode === ScoringMode.LowerWins ? 'lägst vinner (t.ex. snabbast)'
        : a.scoringMode === ScoringMode.ClosestToTarget ? 'närmast målvärdet vinner'
          : 'högst vinner';
      lines.push(`Registrera varje rundas resultat som ${measure} — ${win}.`);
      lines.push(a.scoreEntryMode === ScoreEntryMode.PerPlayer
        ? 'Varje spelare registrerar sitt eget resultat; lagets total är summan.'
        : 'Ett resultat registreras per lag och runda.');
      break;
    }
  }
  return lines;
}
