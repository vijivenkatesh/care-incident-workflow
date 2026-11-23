import { useCallback, useEffect, useState } from 'react';
import {
  Alert, AppBar, Box, Button, Chip, Container, MenuItem, Paper, Select, Stack, Tab, Table, TableBody, TableCell,
  TableHead, TableRow, Tabs, Toolbar, Typography,
} from '@mui/material';
import { IncidentDialog } from './components/IncidentDialog';
import { StatusChip } from './components/StatusChip';
import type { Incident, IncidentStatus, Role } from './api/types';
import type { Session } from './session';

const FILTERS: (IncidentStatus | 'ALL')[] = ['ALL', 'DRAFT', 'SUBMITTED', 'UNDER_REVIEW', 'RETURNED', 'APPROVED', 'REPORTED', 'CLOSED'];

const QUEUE_HINT: Record<Role, string> = {
  staff: 'Raise incidents, then submit them for review. Returned incidents need your changes.',
  supervisor: 'Review submitted incidents: approve them, or return them to staff with a comment.',
  compliance: 'Report approved incidents to the regulator, then close them.',
};

export function App({ session }: { session: Session }) {
  const { user, api, demo } = session;
  const [items, setItems] = useState<Incident[]>([]);
  const [filter, setFilter] = useState<IncidentStatus | 'ALL'>('ALL');
  const [selected, setSelected] = useState<Incident | 'new' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setItems(await api.list(filter === 'ALL' ? undefined : filter));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [api, filter]);

  useEffect(() => {
    void refresh();
  }, [refresh, user.id]);

  const needsMe = items.filter((i) => i.allowedActions.length > 0).length;

  return (
    <Box sx={{ minHeight: '100vh', bgcolor: 'background.default' }}>
      <AppBar position="sticky" color="primary" elevation={0}>
        <Toolbar sx={{ gap: 2, flexWrap: 'wrap', py: 1 }}>
          <Typography variant="h6" component="h1" sx={{ flexGrow: 1 }}>
            Care Incident Workflow
          </Typography>
          {demo ? (
            <Select
              size="small"
              value={user.id}
              onChange={(e) => demo.switchTo(e.target.value)}
              inputProps={{ 'aria-label': 'Signed in as' }}
              sx={{ bgcolor: 'background.paper', minWidth: 220 }}
            >
              {demo.users.map((u) => (
                <MenuItem key={u.id} value={u.id}>{u.name}</MenuItem>
              ))}
            </Select>
          ) : (
            <>
              <Typography variant="body2">{user.name}</Typography>
              <Button color="inherit" onClick={session.signOut}>Sign out</Button>
            </>
          )}
        </Toolbar>
      </AppBar>

      <Container maxWidth="lg" sx={{ py: 3 }}>
        {demo && (
          <Alert severity="info" sx={{ mb: 2 }}>
            Demo mode: data lives in your browser. Switch users above to walk an incident through each role.
          </Alert>
        )}
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} sx={{ mb: 2, alignItems: { sm: 'center' } }}>
          <Box sx={{ flexGrow: 1 }}>
            <Stack direction="row" spacing={1} sx={{ mb: 0.5 }}>
              {user.roles.map((r) => <Chip key={r} label={r} size="small" color="primary" variant="outlined" />)}
              {needsMe > 0 && <Chip label={`${needsMe} need your action`} size="small" color="warning" />}
            </Stack>
            <Typography variant="body2" color="text.secondary">
              {user.roles.map((r) => QUEUE_HINT[r]).join(' ') || 'You have no workflow role. Ask an administrator.'}
            </Typography>
          </Box>
          {user.roles.includes('staff') && (
            <Button variant="contained" onClick={() => setSelected('new')}>New incident</Button>
          )}
        </Stack>

        {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}

        <Paper>
          <Tabs value={filter} onChange={(_, v) => setFilter(v)} variant="scrollable" scrollButtons="auto" aria-label="Filter by status">
            {FILTERS.map((f) => <Tab key={f} value={f} label={f === 'ALL' ? 'All' : f.replace('_', ' ').toLowerCase()} />)}
          </Tabs>
          <Box sx={{ overflowX: 'auto' }}>
            <Table size="small" aria-label="Incidents">
              <TableHead>
                <TableRow>
                  <TableCell>Title</TableCell>
                  <TableCell>Severity</TableCell>
                  <TableCell>Status</TableCell>
                  <TableCell sx={{ display: { xs: 'none', md: 'table-cell' } }}>Raised by</TableCell>
                  <TableCell sx={{ display: { xs: 'none', sm: 'table-cell' } }}>Updated</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {items.map((i) => (
                  <TableRow key={i.id} hover onClick={() => setSelected(i)} sx={{ cursor: 'pointer' }}>
                    <TableCell>
                      {i.title}
                      {i.allowedActions.length > 0 && <Chip label="Action needed" size="small" color="warning" sx={{ ml: 1 }} />}
                    </TableCell>
                    <TableCell>{i.severity}</TableCell>
                    <TableCell><StatusChip status={i.status} /></TableCell>
                    <TableCell sx={{ display: { xs: 'none', md: 'table-cell' } }}>{i.createdBy}</TableCell>
                    <TableCell sx={{ display: { xs: 'none', sm: 'table-cell' } }}>{new Date(i.updatedAt).toLocaleString()}</TableCell>
                  </TableRow>
                ))}
                {items.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={5} align="center" sx={{ py: 4, color: 'text.secondary' }}>
                      No incidents to show.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </Box>
        </Paper>
      </Container>

      {selected && (
        <IncidentDialog
          api={api}
          incident={selected === 'new' ? null : selected}
          onClose={() => setSelected(null)}
          onChanged={(i) => {
            setSelected(i);
            void refresh();
          }}
        />
      )}
    </Box>
  );
}
