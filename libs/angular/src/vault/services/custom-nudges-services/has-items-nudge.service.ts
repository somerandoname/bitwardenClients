import { inject, Injectable } from "@angular/core";
import { combineLatest, Observable, of, switchMap } from "rxjs";
import { catchError, map } from "rxjs/operators";

import { AccountService } from "@bitwarden/common/auth/abstractions/account.service";
import { LogService } from "@bitwarden/common/platform/abstractions/log.service";
import { UserId } from "@bitwarden/common/types/guid";
import { CipherService } from "@bitwarden/common/vault/abstractions/cipher.service";

import { DefaultSingleNudgeService } from "../default-single-nudge.service";
import { NudgeStatus, NudgeType } from "../nudges.service";

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Custom Nudge Service Checking Nudge Status For Welcome Nudge With Populated Vault
 */
@Injectable({
  providedIn: "root",
})
export class HasItemsNudgeService extends DefaultSingleNudgeService {
  cipherService = inject(CipherService);
  accountService = inject(AccountService);
  logService = inject(LogService);

  nudgeStatus$(nudgeType: NudgeType, userId: UserId): Observable<NudgeStatus> {
    const profileDate$ = this.accountService.activeAccount$.pipe(
      map((account) => {
        return account?.creationDate ?? new Date();
      }),
      catchError(() => {
        this.logService.error("Error getting profile creation date");
        // Default to today to ensure we show the nudge
        return of(new Date());
      }),
    );

    // Only whether a non-deleted item exists matters, which the encrypted ciphers answer without
    // decrypting the whole vault the way `cipherViews$` would. PAM-gated (partial) rows are left
    // out, as `cipherViews$` leaves them out.
    const hasItems$ = this.cipherService
      .ciphers$(userId)
      .pipe(
        map((ciphers) =>
          Object.values(ciphers).some(
            (cipher) => cipher.deletedDate == null && cipher.partialData == null,
          ),
        ),
      );

    return combineLatest([
      hasItems$,
      this.getNudgeStatus$(nudgeType, userId),
      profileDate$,
      of(Date.now() - THIRTY_DAYS_MS),
    ]).pipe(
      switchMap(async ([hasItems, nudgeStatus, profileDate, profileCutoff]) => {
        const profileOlderThanCutoff = profileDate.getTime() < profileCutoff;

        if (profileOlderThanCutoff && hasItems && !nudgeStatus.hasSpotlightDismissed) {
          const dismissedStatus = {
            hasSpotlightDismissed: true,
            hasBadgeDismissed: true,
          };
          // permanently dismiss both the Empty Vault Nudge and Has Items Vault Nudge if the profile is older than 30 days
          await this.setNudgeStatus(nudgeType, dismissedStatus, userId);
          await this.setNudgeStatus(NudgeType.EmptyVaultNudge, dismissedStatus, userId);
          return dismissedStatus;
        } else if (nudgeStatus.hasSpotlightDismissed) {
          return nudgeStatus;
        } else {
          return {
            hasBadgeDismissed: !hasItems,
            hasSpotlightDismissed: !hasItems,
          };
        }
      }),
    );
  }
}
