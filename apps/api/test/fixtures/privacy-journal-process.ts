import {
  PrivacyJournal,
  PrivacyJournalConfig,
  PublicationWindow,
} from "../../src/privacy-journal/privacy-journal";

interface Command {
  mode: "publish" | "read" | "wait-publish" | "wait-read";
  config: PrivacyJournalConfig;
  name: string;
  count: number;
  pauseAt?: PublicationWindow;
}
process.once("message", async (command: Command) => {
  try {
    const journal = new PrivacyJournal(
      command.config,
      command.pauseAt
        ? {
            async at(window) {
              if (window === command.pauseAt) {
                process.send?.({ type: "paused" });
                await new Promise<void>(() => {
                  setInterval(() => {}, 1000);
                });
              }
            },
          }
        : undefined,
    );
    if (command.mode.startsWith("wait-")) {
      await new Promise<void>((resolve) => {
        process.once("message", () => resolve());
        process.send?.({ type: "ready" });
      });
    }
    for (let index = 0; index < command.count; index++) {
      if (command.mode.endsWith("read")) await journal.snapshot();
      else
        await journal.append({
          eventId: `${command.name}-${index}`,
          projectId: "synthetic-project",
          kind: "deletion",
          occurredAt: "2026-10-27T00:00:00.000Z",
          payload: { categories: ["all"] },
        });
    }
    process.send?.({ type: "done" });
    process.disconnect();
  } catch {
    // Do not echo config/key/payload on fixture failure.
    process.send?.({ type: "failed" });
    process.disconnect();
    process.exitCode = 1;
  }
});
