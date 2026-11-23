import { Chip } from '@mui/material';
import { STATUS_COLOURS, type IncidentStatus } from '../api/types';

export function StatusChip({ status }: { status: IncidentStatus }) {
  return <Chip size="small" label={status.replace('_', ' ')} color={STATUS_COLOURS[status]} />;
}
