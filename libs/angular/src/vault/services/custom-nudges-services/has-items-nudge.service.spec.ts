import { TestBed } from "@angular/core/testing";
import { mock, MockProxy } from "jest-mock-extended";
import { firstValueFrom, of } from "rxjs";

import { AccountService } from "@bitwarden/common/auth/abstractions/account.service";
import { LogService } from "@bitwarden/common/platform/abstractions/log.service";
import { StateProvider } from "@bitwarden/common/platform/state";
import { CipherId, UserId } from "@bitwarden/common/types/guid";
import { CipherService } from "@bitwarden/common/vault/abstractions/cipher.service";
import { CipherData } from "@bitwarden/common/vault/models/data/cipher.data";

import { FakeStateProvider, mockAccountServiceWith } from "../../../../../../libs/common/spec";
import { NUDGE_DISMISSED_DISK_KEY, NudgeType } from "../nudges.service";

import { HasItemsNudgeService } from "./has-items-nudge.service";

const DAY_MS = 24 * 60 * 60 * 1000;

describe("HasItemsNudgeService", () => {
  const userId = "user-id" as UserId;
  const nudgeType = NudgeType.HasVaultItems;
  let cipherService: MockProxy<CipherService>;
  let fakeStateProvider: FakeStateProvider;

  function ciphers(...entries: Partial<CipherData>[]): Record<CipherId, CipherData> {
    return Object.fromEntries(
      entries.map((data, i) => [`cipher-${i}`, { id: `cipher-${i}`, ...data } as CipherData]),
    ) as Record<CipherId, CipherData>;
  }

  function createService(accountAgeDays: number, vault: Record<CipherId, CipherData>) {
    const accountService = mockAccountServiceWith(userId, {
      creationDate: new Date(Date.now() - accountAgeDays * DAY_MS),
    });
    fakeStateProvider = new FakeStateProvider(accountService);
    cipherService = mock<CipherService>();
    cipherService.ciphers$.mockReturnValue(of(vault));

    TestBed.configureTestingModule({
      providers: [
        HasItemsNudgeService,
        { provide: StateProvider, useValue: fakeStateProvider },
        { provide: CipherService, useValue: cipherService },
        { provide: AccountService, useValue: accountService },
        { provide: LogService, useValue: mock<LogService>() },
      ],
    });

    return TestBed.inject(HasItemsNudgeService);
  }

  it("shows the nudge for a new account with a non-deleted item", async () => {
    const service = createService(1, ciphers({}));

    const status = await firstValueFrom(service.nudgeStatus$(nudgeType, userId));

    expect(status).toEqual({ hasBadgeDismissed: false, hasSpotlightDismissed: false });
  });

  it("hides the nudge when only deleted or PAM-gated items exist", async () => {
    const service = createService(
      1,
      ciphers({ deletedDate: "2026-01-01T00:00:00.000Z" }, { partialData: '{"Name":"enc-name"}' }),
    );

    const status = await firstValueFrom(service.nudgeStatus$(nudgeType, userId));

    expect(status).toEqual({ hasBadgeDismissed: true, hasSpotlightDismissed: true });
  });

  it("permanently dismisses both vault nudges for accounts older than 30 days with items", async () => {
    const service = createService(31, ciphers({}));

    const status = await firstValueFrom(service.nudgeStatus$(nudgeType, userId));

    const dismissed = { hasBadgeDismissed: true, hasSpotlightDismissed: true };
    expect(status).toEqual(dismissed);
    // The first write re-emits the nudge state, which resolves the status before the
    // empty-vault nudge has been written.
    await new Promise((resolve) => setTimeout(resolve, 0));
    const stored = await firstValueFrom(
      fakeStateProvider.getUser(userId, NUDGE_DISMISSED_DISK_KEY).state$,
    );
    expect(stored).toEqual({
      [NudgeType.HasVaultItems]: dismissed,
      [NudgeType.EmptyVaultNudge]: dismissed,
    });
  });

  it("keeps a dismissed nudge dismissed", async () => {
    const service = createService(1, ciphers({}));
    const dismissed = { hasBadgeDismissed: true, hasSpotlightDismissed: true };
    fakeStateProvider.singleUser
      .getFake(userId, NUDGE_DISMISSED_DISK_KEY)
      .nextState({ [nudgeType]: dismissed });

    const status = await firstValueFrom(service.nudgeStatus$(nudgeType, userId));

    expect(status).toEqual(dismissed);
  });

  it("does not decrypt the vault", async () => {
    const service = createService(1, ciphers({}));

    await firstValueFrom(service.nudgeStatus$(nudgeType, userId));

    expect(cipherService.cipherViews$).not.toHaveBeenCalled();
  });
});
