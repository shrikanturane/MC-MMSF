process.env.AUTH_SECRET = 'unit-test-secret';
import { signJwt, verifyJwt } from '../src/auth/jwt';

describe('auth/jwt (HS256)', () => {
  const payload = { sub: 'u1', role: 'admin' as const, name: 'Test', email: 't@x.io' };

  it('signs and verifies a round-trip', () => {
    const t = signJwt(payload);
    const v = verifyJwt(t);
    expect(v).not.toBeNull();
    expect(v!.sub).toBe('u1');
    expect(v!.role).toBe('admin');
    expect(v!.exp! > Math.floor(Date.now() / 1000)).toBe(true);
  });

  it('rejects a tampered signature', () => {
    const [h, b, s] = signJwt(payload).split('.');
    const tampered = `${h}.${b}.AAAA${s.slice(4)}`;
    expect(verifyJwt(tampered)).toBeNull();
  });

  it('rejects an expired token', () => {
    expect(verifyJwt(signJwt(payload, -10))).toBeNull();
  });

  it('rejects malformed input', () => {
    expect(verifyJwt('')).toBeNull();
    expect(verifyJwt('a.b')).toBeNull();
    expect(verifyJwt('not-a-token')).toBeNull();
  });

  it('rejects a token signed with a different secret', () => {
    const t = signJwt(payload);
    process.env.AUTH_SECRET = 'different-secret';
    expect(verifyJwt(t)).toBeNull();
    process.env.AUTH_SECRET = 'unit-test-secret';
  });
});
