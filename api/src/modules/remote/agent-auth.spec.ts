import { decideAgentAuth, isOlderThan, REMOTE_AUTH_MIN_AGENT_VERSION } from './agent-auth';

const SHARED = 'shared-bootstrap-key-000000';
const TOKEN = 'per-agent-token-abcdefghijklmnop';

describe('remote agent-auth', () => {
  const base = { sharedKey: SHARED, agentToken: TOKEN, agentVersion: REMOTE_AUTH_MIN_AGENT_VERSION };

  it('accepts the session agent\'s own token', () => {
    expect(decideAgentAuth({ ...base, presentedKey: TOKEN })).toBe('ok');
  });

  it('accepts the shared bootstrap key', () => {
    expect(decideAgentAuth({ ...base, presentedKey: SHARED })).toBe('ok');
  });

  it('denies a wrong key, including another agent\'s token', () => {
    expect(decideAgentAuth({ ...base, presentedKey: 'someone-elses-token-zzzzzzzzzzzz' })).toBe('deny');
    expect(decideAgentAuth({ ...base, agentToken: null, presentedKey: TOKEN })).toBe('deny');
  });

  it('denies a keyless call from a current agent — the consent-bypass case', () => {
    expect(decideAgentAuth({ ...base, presentedKey: '' })).toBe('deny');
  });

  it('denies a keyless call when the agent version is unknown', () => {
    expect(decideAgentAuth({ ...base, agentVersion: null, presentedKey: '' })).toBe('deny');
    expect(decideAgentAuth({ ...base, agentVersion: 'garbage', presentedKey: '' })).toBe('deny');
  });

  it('lets a pre-update agent through keyless until it self-updates, unless strict', () => {
    expect(decideAgentAuth({ ...base, agentVersion: '1.20.14', presentedKey: '' })).toBe('legacy');
    expect(decideAgentAuth({ ...base, agentVersion: '1.20.14', presentedKey: '', strict: true })).toBe('deny');
  });

  it('a wrong key is denied even for a legacy agent', () => {
    expect(decideAgentAuth({ ...base, agentVersion: '1.20.14', presentedKey: 'nope' })).toBe('deny');
  });

  it('compares versions numerically', () => {
    expect(isOlderThan('1.20.14', '1.20.15')).toBe(true);
    expect(isOlderThan('1.9.99', '1.20.15')).toBe(true);
    expect(isOlderThan('1.20.15', '1.20.15')).toBe(false);
    expect(isOlderThan('1.21.0', '1.20.15')).toBe(false);
    expect(isOlderThan('2', '1.20.15')).toBe(false);
  });
});
