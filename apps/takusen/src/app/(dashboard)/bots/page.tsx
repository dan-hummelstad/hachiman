import { DashboardShell } from "@/components/dashboard-shell";
import { getViewer } from "@/lib/account";
import { listBots, listManageableGuilds } from "@/lib/bot-accounts";
import { botServerOrigin } from "@/lib/bots";

import { BotsPanel, CreateBotPanel } from "./bots-panel";

export const metadata = {
  title: "Bots · Takusen",
};

export default async function BotsPage(): Promise<React.JSX.Element | null> {
  // Null only in the render inside a sign-out action; the layout sends signed-out visitors to /login.
  const viewer = await getViewer();
  if (!viewer) return null;
  const bots = await listBots(viewer.id);
  const origin = botServerOrigin();
  const guilds = await listManageableGuilds(viewer.id);

  return (
    <DashboardShell
      section="account"
      crumbs={[{ label: "Bots" }]}
      title="Bots"
      description="Bot accounts that you own. A bot signs in with its token and is an end-to-end encrypted member, the same as a user."
    >
      <div className="grid gap-5 xl:grid-cols-2 xl:items-start [&>*]:min-w-0">
        <BotsPanel bots={bots} origin={origin} guilds={guilds} />
        <CreateBotPanel origin={origin} />
      </div>
    </DashboardShell>
  );
}
