import { DateTime}              from 'luxon';
import TWT                      from 'mythix-twt';
import { Utils as MythixUtils } from 'mythix';
import { Types }                from 'mythix';
import { ModelBase }            from './model-base.mjs';
import Utils                    from '../utils/index.mjs';

const {
  CryptoUtils,
} = MythixUtils;

// This model blacklists TWT
// tokens, marking them as
// no-longer valid.
//
// "purgeAt" is set to 120 seconds
// beyond the expire time of the
// token itself. Past this time, we
// can purge the token from the database
// to keep things clean.

export class InvalidToken extends ModelBase {
  static fields = {
    ...(ModelBase.fields || {}),
    id: {
      type:         Types.XID({ prefix: Utils.getModelIDPrefixFor('InvalidToken') }),
      defaultValue: Types.XID.Default.XID,
      allowNull:    false,
      primaryKey:   true,
    },
    tokenHash: {
      // eslint-disable-next-line no-magic-numbers
      type:         Types.STRING(32),
      allowNull:    false,
      index:        true,
    },
    purgeAt: {
      type:         Types.DATETIME,
      allowNull:    false,
      index:        true,
    },
  };

  static async createForToken(token) {
    let {
      InvalidToken,
    } = this.getModels();

    let app = this.getApplication();

    // Purge expired tokens
    try {
      await InvalidToken.where.purgeAt.LT(DateTime.now()).destroy();
    } catch (error) {
      // NOOP
    }

    // Blacklist token
    try {
      let claims = TWT.verifyTWT(token, app.getSalt());

      await InvalidToken.create({
        tokenHash:  CryptoUtils.MD5(token),
        // eslint-disable-next-line no-magic-numbers
        purgeAt:    (claims.expiresAt + 120) * 1000.0,
      });
    } catch (error) {
      // NOOP
    }
  }

  static async isInvalid(token) {
    let {
      InvalidToken,
    } = this.getModels();

    let tokenHash = CryptoUtils.MD5(token);
    return await InvalidToken.where.tokenHash.EQ(tokenHash).exists();
  }
}
