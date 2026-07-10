import { buildGcpCostQuery } from './gcp.adapter';

const AUG = new Date(Date.UTC(2026, 7, 15)); // 2026-08-15

describe('GCP billing-export query builder (schema by table name)', () => {
  test('FOCUS export → FOCUS schema + ChargePeriodStart month window', () => {
    const { sql, schema } = buildGcpCostQuery('proj.ds.gcp_billing_export_focus_012731_ABC', AUG);
    expect(schema).toBe('FOCUS');
    expect(sql).toContain('ServiceName AS service');
    expect(sql).toContain('SUM(BilledCost)');
    expect(sql).toContain('BillingCurrency');
    expect(sql).toContain("ChargePeriodStart >= TIMESTAMP('2026-08-01')");
    expect(sql).toContain("ChargePeriodStart < TIMESTAMP('2026-09-01')");
    expect(sql).not.toContain('invoice.month');
  });

  test('standard v1 export → legacy schema + invoice.month', () => {
    const { sql, schema } = buildGcpCostQuery('proj.ds.gcp_billing_export_v1_012731_ABC', AUG);
    expect(schema).toBe('standard');
    expect(sql).toContain('service.description AS service');
    expect(sql).toContain('SUM(cost)');
    expect(sql).toContain("invoice.month = '202608'");
    expect(sql).not.toContain('BilledCost');
  });

  test('detailed usage cost (resource_v1) uses the standard schema', () => {
    const { schema } = buildGcpCostQuery('proj.ds.gcp_billing_export_resource_v1_012731_ABC', AUG);
    expect(schema).toBe('standard');
  });

  test('year/December rollover computes the next-month window correctly', () => {
    const { sql } = buildGcpCostQuery('p.d.gcp_billing_export_focus_x', new Date(Date.UTC(2026, 11, 3)));
    expect(sql).toContain("ChargePeriodStart >= TIMESTAMP('2026-12-01')");
    expect(sql).toContain("ChargePeriodStart < TIMESTAMP('2027-01-01')");
  });

  test('deterministic: same table + clock → identical SQL', () => {
    const t = 'p.d.gcp_billing_export_focus_x';
    expect(buildGcpCostQuery(t, AUG).sql).toBe(buildGcpCostQuery(t, AUG).sql);
  });
});
