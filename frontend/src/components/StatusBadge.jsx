// Renders an activity's status as a coloured Pill with its Swedish label.
//   Draft → Utkast (neutral) · Open → Öppen (accent/blue)
//   Live  → Pågår  (live/red) · Finished → Avslutad (ok/green)
// `status` is the integer ActivityStatus (matches the wire enum). Strings are
// tolerated for convenience.
import Pill from './Pill';
import { ActivityStatus, ActivityStatusLabel } from '../config/enums';

const KIND_BY_STATUS = {
  [ActivityStatus.Draft]: undefined, // neutral default pill
  [ActivityStatus.Open]: 'accent',
  [ActivityStatus.Live]: 'live',
  [ActivityStatus.Finished]: 'ok',
};

export default function StatusBadge({ status }) {
  const value = typeof status === 'string' ? Number(status) : status;
  const label = ActivityStatusLabel[value] ?? 'Okänd';
  const kind = KIND_BY_STATUS[value];
  return <Pill kind={kind}>{label}</Pill>;
}
