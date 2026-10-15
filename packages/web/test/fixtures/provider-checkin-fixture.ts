import type { IProviderAccountService } from "@lcode/services";
import type { ProviderAccount, ProviderAccountView } from "@lcode/shared";

export function createCheckinFixture(
  fixture: { accounts: ProviderAccount[]; checkins: string[] },
  publish: () => ProviderAccountView,
) {
  const methods: Pick<
    IProviderAccountService,
    "checkinAccount" | "checkinAll" | "setAutomaticCheckin"
  > = {
    async checkinAccount(id) {
      const account = fixture.accounts.find((a) => a.connectionId === id);
      if (account?.enabled) {
        fixture.checkins.push(id);
        account.checkin = {
          automatic: account.checkin?.automatic ?? false,
          result: {
            outcome: id === "account-2" ? "own-app" : "claimed",
            credit: id === "account-2" ? undefined : 25,
            at: new Date().toISOString(),
            day: "2026-10-15",
          },
        };
      }
      return publish();
    },
    async checkinAll(channelId) {
      for (const account of fixture.accounts.filter(
        (a) => a.enabled && (!channelId || a.channelId === channelId),
      ))
        await methods.checkinAccount(account.connectionId);
      return publish();
    },
    async setAutomaticCheckin(id, automatic) {
      const account = fixture.accounts.find((a) => a.connectionId === id);
      if (account) account.checkin = { ...account.checkin, automatic };
      return publish();
    },
  };
  return methods;
}
