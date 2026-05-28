import Utils from '../../app/utils/index.mjs';
import { PREFIXED_XID_REGEXP } from '../support/application.mjs';

describe('model-utils', function() {
  describe('XID', function() {
    it('should be able to generate a XID', function() {
      expect(`ROL_${Utils.XID()}`).toMatch(PREFIXED_XID_REGEXP);
    });
  });

  describe('isValidID', function() {
    it('should be able to check XID', function() {
      expect(Utils.isValidID(`ROL_${Utils.XID()}`)).toEqual(true);
      expect(Utils.isValidID(Utils.XID())).toEqual(false);
      expect(Utils.isValidID('ROL_Zd06dx7qqwpgbh6yqp3g')).toEqual(false);
      expect(Utils.isValidID('ROL_cd06dx7qqwpgbh6yqp3g2')).toEqual(false);
    });
  });
});
