import { useEffect, useState } from 'react';

// `beforeinstallprompt` isn't in TypeScript's DOM lib yet — this is the
// minimal real shape (MDN/the spec draft) this component actually reads.
interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

// Spec §11 M6: "install prompt." Placed in AppShell's nav, next to
// NotificationBell — the one piece of chrome visible across all 9
// authenticated pages during actual work, unlike the login screen (a
// one-time, low-frequency touch point) where installing isn't the
// obvious next action. Renders nothing until the browser actually fires
// `beforeinstallprompt` (already installed, or a browser that doesn't
// support the event at all — e.g. iOS Safari — never shows this), and
// disappears again once installed.
export function InstallButton() {
  const [installEvent, setInstallEvent] = useState<BeforeInstallPromptEvent | null>(null);

  useEffect(() => {
    function handleBeforeInstallPrompt(event: Event) {
      event.preventDefault();
      setInstallEvent(event as BeforeInstallPromptEvent);
    }
    function handleAppInstalled() {
      setInstallEvent(null);
    }
    window.addEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
    window.addEventListener('appinstalled', handleAppInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
      window.removeEventListener('appinstalled', handleAppInstalled);
    };
  }, []);

  if (!installEvent) {
    return null;
  }

  const handleClick = async () => {
    await installEvent.prompt();
    // The prompt can only be shown once per captured event, accepted or
    // not — either way there's nothing left to do with this one.
    await installEvent.userChoice;
    setInstallEvent(null);
  };

  return (
    <button
      type="button"
      onClick={() => void handleClick()}
      className="rounded border border-blue-300 px-2 py-1 text-xs font-medium text-blue-700 hover:bg-blue-50"
    >
      Install app
    </button>
  );
}
