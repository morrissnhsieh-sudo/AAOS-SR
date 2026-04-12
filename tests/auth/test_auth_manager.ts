import { validate_line_signature } from '../../src/auth/auth_manager';

describe('Auth Manager', () => {
    it('test_validate_line_signature_AC_002', () => {
        expect(validate_line_signature('body', 'bad_sig', 'secret')).toBe(false);
    });
});
