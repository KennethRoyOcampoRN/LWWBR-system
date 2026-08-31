import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { InstallButton } from '../src/components/InstallButton.js';

function makeBeforeInstallPromptEvent(outcome: 'accepted' | 'dismissed' = 'accepted') {
  const event = new Event('beforeinstallprompt', { cancelable: true }) as Event & {
    prompt: () => Promise<void>;
    userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
  };
  event.prompt = vi.fn().mockResolvedValue(undefined);
  event.userChoice = Promise.resolve({ outcome });
  return event;
}

describe('InstallButton', () => {
  it('renders nothing until the browser fires beforeinstallprompt', () => {
    render(<InstallButton />);
    expect(screen.queryByRole('button', { name: 'Install app' })).not.toBeInTheDocument();
  });

  it('shows the button once beforeinstallprompt fires, and calls prompt() on click', async () => {
    const user = userEvent.setup();
    render(<InstallButton />);

    const event = makeBeforeInstallPromptEvent('accepted');
    act(() => {
      window.dispatchEvent(event);
    });

    const button = await screen.findByRole('button', { name: 'Install app' });
    await user.click(button);

    expect(event.prompt).toHaveBeenCalledTimes(1);
  });

  it('hides itself again after a click resolves (the captured event is single-use)', async () => {
    const user = userEvent.setup();
    render(<InstallButton />);

    act(() => {
      window.dispatchEvent(makeBeforeInstallPromptEvent('dismissed'));
    });
    const button = await screen.findByRole('button', { name: 'Install app' });
    await user.click(button);

    expect(screen.queryByRole('button', { name: 'Install app' })).not.toBeInTheDocument();
  });

  it('hides itself when appinstalled fires', async () => {
    render(<InstallButton />);

    act(() => {
      window.dispatchEvent(makeBeforeInstallPromptEvent());
    });
    await screen.findByRole('button', { name: 'Install app' });

    act(() => {
      window.dispatchEvent(new Event('appinstalled'));
    });

    await waitFor(() => expect(screen.queryByRole('button', { name: 'Install app' })).not.toBeInTheDocument());
  });
});
