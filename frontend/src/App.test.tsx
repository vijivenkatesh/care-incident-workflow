import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from './App';
import { createDemoSession, type Session } from './session';
import { validate } from './components/IncidentDialog';

afterEach(cleanup);

function renderApp() {
  let rerender: (s: Session) => void = () => undefined;
  const session = createDemoSession((s) => rerender(s));
  const view = render(<App session={session} />);
  rerender = (s) => act(() => view.rerender(<App session={s} />));
  return session;
}

const switchUser = async (name: string) => {
  await userEvent.click(screen.getByRole('combobox', { name: 'Signed in as' }));
  await userEvent.click(await screen.findByRole('option', { name }));
};

describe('role-based incident workflow', () => {
  it('walks an incident from staff to supervisor to compliance', async () => {
    renderApp();

    // Staff raises and submits.
    await userEvent.click(screen.getByRole('button', { name: 'New incident' }));
    await userEvent.type(screen.getByLabelText(/Title/), 'Client fall in kitchen');
    await userEvent.type(screen.getByLabelText(/What happened/), 'Client slipped on a wet floor.');
    await userEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Submit for review' }));
    expect((await screen.findByRole('dialog')).textContent).toContain('SUBMITTED');
    await userEvent.click(screen.getByRole('button', { name: 'Close' }));

    // Supervisor sees it in their queue; return requires a comment.
    await switchUser('Priya (Supervisor)');
    await userEvent.click(await screen.findByText('Client fall in kitchen'));
    expect(screen.queryByRole('button', { name: 'Submit for review' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Start review' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Return to staff' }));
    expect((screen.getByRole('button', { name: 'Confirm return' }) as HTMLButtonElement).disabled).toBe(true);
    await userEvent.type(screen.getByLabelText(/What needs to change/), 'Add witness names');
    await userEvent.click(screen.getByRole('button', { name: 'Confirm return' }));
    expect((await screen.findByRole('dialog')).textContent).toContain('RETURNED');
    await userEvent.click(screen.getByRole('button', { name: 'Close' }));

    // Compliance cannot see it until approved.
    await switchUser('Chris (Compliance)');
    expect(await screen.findByText('No incidents to show.')).toBeTruthy();

    // A different staff member cannot see Sam's incident.
    await switchUser('Alex (Staff)');
    expect(await screen.findByText('No incidents to show.')).toBeTruthy();

    // Owner sees the supervisor's comment and resubmits.
    await switchUser('Sam (Staff)');
    await userEvent.click(await screen.findByText('Client fall in kitchen'));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/Add witness names/, { selector: 'div' })).toBeTruthy();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Submit for review' }));
    expect((await screen.findByRole('dialog')).textContent).toContain('SUBMITTED');
  });
});

describe('form validation mirrors the API contract', () => {
  it('rejects short fields and future dates', () => {
    const errors = validate({ title: 'x', description: 'short', severity: 'LOW', occurredAt: '2999-01-01T00:00', location: '' });
    expect(Object.keys(errors).sort()).toEqual(['description', 'occurredAt', 'title']);
  });
});
