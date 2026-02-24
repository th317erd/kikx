import Utils from '../../app/utils/index.mjs';

describe('formatter-utils', function() {
  describe('formatPhoneNumber', function() {
    it('should be able to format a phone number for storage', function() {
      expect(Utils.formatPhoneNumber('987-654-3210', 'DB')).toEqual('19876543210');
      expect(Utils.formatPhoneNumber('1-987-654-3210 ', 'DB')).toEqual('19876543210');
      expect(Utils.formatPhoneNumber(' +1-987654-3210', 'DB')).toEqual('19876543210');
    });

    it('should be able to format a phone number for display', function() {
      expect(Utils.formatPhoneNumber('1-987-654-3210')).toEqual('+1-987-654-3210');
      expect(Utils.formatPhoneNumber(' 19876543210 ')).toEqual('+1-987-654-3210');
      expect(Utils.formatPhoneNumber('9876543210')).toEqual('+1-987-654-3210');
    });

    it('should fail with a bad phone number', function() {
      expect(Utils.formatPhoneNumber('87-654-3210')).toBe(null);
      expect(Utils.formatPhoneNumber('87-654-3210', 'DB')).toBe(null);
    });
  });
});
