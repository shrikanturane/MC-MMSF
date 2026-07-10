import { classifyPrivilege } from './ciem.service';

describe('CIEM privilege classification (thesis 6.4)', () => {
  test('admin tier: AdministratorAccess / Owner / roles/owner / wildcards', () => {
    expect(classifyPrivilege(['AdministratorAccess'])).toBe('admin');
    expect(classifyPrivilege(['Owner'])).toBe('admin');
    expect(classifyPrivilege(['roles/owner'])).toBe('admin');
    expect(classifyPrivilege(['*:*'])).toBe('admin');
  });

  test('write tier: Contributor / editor / PowerUser', () => {
    expect(classifyPrivilege(['Contributor'])).toBe('write');
    expect(classifyPrivilege(['roles/editor'])).toBe('write');
    expect(classifyPrivilege(['PowerUserAccess'])).toBe('write');
  });

  test('read tier: ReadOnly / Reader / viewer; empty = read', () => {
    expect(classifyPrivilege(['ReadOnlyAccess'])).toBe('read');
    expect(classifyPrivilege(['Reader'])).toBe('read');
    expect(classifyPrivilege(['roles/viewer'])).toBe('read');
    expect(classifyPrivilege([])).toBe('read');
  });

  test('unrecognized named policies = custom (never silently admin)', () => {
    expect(classifyPrivilege(['Storage Blob Data Something', 'MyTeamPolicy'])).toBe('custom');
  });

  test('deterministic: same input → same tier', () => {
    const perms = ['Contributor', 'Reader'];
    expect(classifyPrivilege(perms)).toBe(classifyPrivilege(perms));
  });
});
