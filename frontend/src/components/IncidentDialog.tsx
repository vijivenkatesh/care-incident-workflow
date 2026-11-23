import { useState } from 'react';
import {
  Alert, Box, Button, Dialog, DialogActions, DialogContent, DialogTitle, Divider, List, ListItem, ListItemText,
  MenuItem, Stack, TextField, Typography, useMediaQuery, useTheme,
} from '@mui/material';
import { StatusChip } from './StatusChip';
import { ACTION_LABELS, ApiError, type Action, type Incident, type IncidentApi, type IncidentInput, type Severity } from '../api/types';

const SEVERITIES: Severity[] = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];

interface FormState { title: string; description: string; severity: Severity; occurredAt: string; location: string }

const toLocalInput = (iso: string) => {
  const d = new Date(iso);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
};

function initialForm(i: Incident | null): FormState {
  return {
    title: i?.title ?? '',
    description: i?.description ?? '',
    severity: i?.severity ?? 'MEDIUM',
    occurredAt: toLocalInput(i?.occurredAt ?? new Date().toISOString()),
    location: i?.location ?? '',
  };
}

/** Client-side checks mirror the OpenAPI constraints so users get instant feedback. */
export function validate(f: FormState): Partial<Record<keyof FormState, string>> {
  const errors: Partial<Record<keyof FormState, string>> = {};
  if (f.title.trim().length < 3 || f.title.length > 120) errors.title = 'Title must be 3–120 characters';
  if (f.description.trim().length < 10 || f.description.length > 4000) errors.description = 'Describe what happened (at least 10 characters)';
  if (!f.occurredAt || Number.isNaN(Date.parse(f.occurredAt))) errors.occurredAt = 'Enter when it happened';
  else if (new Date(f.occurredAt) > new Date()) errors.occurredAt = 'Cannot be in the future';
  if (f.location.length > 200) errors.location = 'Location must be at most 200 characters';
  return errors;
}

const toInput = (f: FormState): IncidentInput => ({
  title: f.title.trim(),
  description: f.description.trim(),
  severity: f.severity,
  occurredAt: new Date(f.occurredAt).toISOString(),
  ...(f.location.trim() ? { location: f.location.trim() } : {}),
});

const describeError = (e: unknown) =>
  e instanceof ApiError
    ? `${e.body.message}${e.body.errors ? ': ' + e.body.errors.join('; ') : ''}${e.body.correlationId ? ` (ref ${e.body.correlationId.slice(0, 8)})` : ''}`
    : (e as Error).message;

interface Props {
  api: IncidentApi;
  incident: Incident | null;
  onClose(): void;
  onChanged(i: Incident): void;
}

export function IncidentDialog({ api, incident, onClose, onChanged }: Props) {
  const fullScreen = useMediaQuery(useTheme().breakpoints.down('sm'));
  const [form, setForm] = useState<FormState>(() => initialForm(incident));
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [comment, setComment] = useState('');
  const [returning, setReturning] = useState(false);

  const editable = incident === null || incident.canEdit;
  const errors = touched ? validate(form) : {};
  const dirty = JSON.stringify(form) !== JSON.stringify(initialForm(incident));

  const run = async (fn: () => Promise<Incident>) => {
    setBusy(true);
    setError(null);
    try {
      const updated = await fn();
      setForm(initialForm(updated));
      setTouched(false);
      setReturning(false);
      setComment('');
      onChanged(updated);
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  };

  const save = () => {
    setTouched(true);
    if (Object.keys(validate(form)).length) return;
    void run(() => (incident ? api.update(incident.id, toInput(form)) : api.create(toInput(form))));
  };

  const act = (action: Action) => {
    if (action === 'RETURN' && !returning) return setReturning(true);
    if (dirty && editable) return setError('Save your changes before submitting');
    void run(() => api.transition(incident!.id, action, comment || undefined));
  };

  const field = (key: keyof FormState) => ({
    value: form[key],
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [key]: e.target.value }),
    error: Boolean(errors[key]),
    helperText: errors[key],
    disabled: !editable || busy,
    fullWidth: true,
  });

  return (
    <Dialog open onClose={onClose} fullScreen={fullScreen} maxWidth="md" fullWidth aria-labelledby="incident-title">
      <DialogTitle id="incident-title">
        <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
          <Box sx={{ flexGrow: 1 }}>{incident ? incident.title : 'New incident'}</Box>
          {incident && <StatusChip status={incident.status} />}
        </Stack>
      </DialogTitle>
      <DialogContent dividers>
        {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}
        {incident?.status === 'RETURNED' && incident.canEdit && (
          <Alert severity="warning" sx={{ mb: 2 }}>
            Returned by supervisor: {[...incident.history].reverse().find((h) => h.action === 'RETURN')?.comment}
          </Alert>
        )}
        {incident?.regulatorReference && (
          <Alert severity="success" sx={{ mb: 2 }}>Regulator reference: {incident.regulatorReference}</Alert>
        )}
        <Stack spacing={2}>
          <TextField label="Title" required {...field('title')} />
          <TextField label="What happened" required multiline minRows={3} {...field('description')} />
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
            <TextField select label="Severity" {...field('severity')}>
              {SEVERITIES.map((s) => <MenuItem key={s} value={s}>{s}</MenuItem>)}
            </TextField>
            <TextField label="Occurred at" type="datetime-local" slotProps={{ inputLabel: { shrink: true } }} {...field('occurredAt')} />
          </Stack>
          <TextField label="Location" {...field('location')} />
        </Stack>

        {returning && (
          <TextField
            sx={{ mt: 2 }}
            label="What needs to change? (sent to staff)"
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            multiline
            minRows={2}
            fullWidth
            autoFocus
          />
        )}

        {incident && (
          <>
            <Divider sx={{ my: 2 }} />
            <Typography variant="subtitle2">History (audit trail)</Typography>
            <List dense>
              {incident.history.map((h, idx) => (
                <ListItem key={idx} disableGutters>
                  <ListItemText
                    primary={`${h.action.replace('_', ' ')}: ${h.from} → ${h.to}`}
                    secondary={`${h.by}, ${new Date(h.at).toLocaleString()}${h.comment ? ` · "${h.comment}"` : ''}`}
                  />
                </ListItem>
              ))}
            </List>
          </>
        )}
      </DialogContent>
      <DialogActions sx={{ flexWrap: 'wrap', gap: 1 }}>
        <Button onClick={onClose}>Close</Button>
        {editable && (
          <Button onClick={save} disabled={busy || (incident !== null && !dirty)} variant={incident ? 'outlined' : 'contained'}>
            {incident ? 'Save changes' : 'Save draft'}
          </Button>
        )}
        {/* Buttons come from the server's allowedActions: the UI never decides who may do what. */}
        {incident?.allowedActions.map((a) => (
          <Button
            key={a}
            variant="contained"
            color={a === 'RETURN' ? 'warning' : 'primary'}
            disabled={busy || (a === 'RETURN' && returning && !comment.trim())}
            onClick={() => act(a)}
          >
            {a === 'RETURN' && returning ? 'Confirm return' : ACTION_LABELS[a]}
          </Button>
        ))}
      </DialogActions>
    </Dialog>
  );
}
