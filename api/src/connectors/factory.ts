import type { CloudConnector } from './adapter';
import { AwsConnector } from './aws.adapter';
import { AzureConnector } from './azure.adapter';
import { GcpConnector } from './gcp.adapter';
import { DockerConnector } from './docker.adapter';
import { SshConnector } from './ssh.adapter';
import { VmwareConnector, NutanixConnector, ProxmoxConnector, KvmConnector } from './hypervisor.adapter';

/** Providers that have a real connector implementation. */
export const SUPPORTED_PROVIDERS = ['aws', 'azure', 'gcp', 'docker', 'linux', 'windows', 'vmware', 'esxi', 'nutanix', 'proxmox', 'kvm'] as const;

/** Resolve the real connector for a provider. Throws for providers without an implementation. */
export function getConnector(provider: string): CloudConnector {
  switch (provider) {
    case 'aws':
      return new AwsConnector();
    case 'azure':
      return new AzureConnector();
    case 'gcp':
      return new GcpConnector();
    case 'docker':
      return new DockerConnector();
    case 'linux':
      return new SshConnector('linux');
    case 'windows':
      return new SshConnector('windows');
    case 'vmware':
      return new VmwareConnector('vmware');
    case 'esxi':
      return new VmwareConnector('esxi'); // standalone ESXi 7+ exposes the same vSphere REST API
    case 'nutanix':
      return new NutanixConnector();
    case 'proxmox':
      return new ProxmoxConnector();
    case 'kvm':
      return new KvmConnector();
    default:
      throw new Error(`No real connector for provider "${provider}" yet (supported: ${SUPPORTED_PROVIDERS.join(', ')})`);
  }
}
