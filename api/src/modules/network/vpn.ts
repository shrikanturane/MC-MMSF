import { createHmac } from 'node:crypto';

/** Stable, non-stored pre-shared key for a cloud pair (derived from the app key). */
export function derivePsk(a: string, b: string): string {
  const key = process.env.APP_ENCRYPTION_KEY || 'mcmf-dev-key';
  const [x, y] = [a, b].sort();
  return createHmac('sha256', key).update(`vpn-psk:${x}:${y}`).digest('hex').slice(0, 32);
}

/** Firewall rules that MUST be open (both directions) between the two VPN gateways. */
export const VPN_RULES = [
  { direction: 'inbound', protocol: 'UDP', port: '500', purpose: 'IKE / ISAKMP key exchange' },
  { direction: 'inbound', protocol: 'UDP', port: '4500', purpose: 'IPsec NAT-Traversal' },
  { direction: 'inbound', protocol: 'ESP (IP proto 50)', port: '—', purpose: 'Encrypted ESP payload' },
  { direction: 'outbound', protocol: 'UDP', port: '500', purpose: 'IKE / ISAKMP key exchange' },
  { direction: 'outbound', protocol: 'UDP', port: '4500', purpose: 'IPsec NAT-Traversal' },
  { direction: 'outbound', protocol: 'ESP (IP proto 50)', port: '—', purpose: 'Encrypted ESP payload' },
];

const DEFAULT_CIDR: Record<string, string> = { aws: '10.30.0.0/16', azure: '10.20.0.0/16', gcp: '10.40.0.0/16' };

/** Per-cloud CLI to deploy this side of the tunnel. Peer gateway IP is filled once the peer exists. */
export function buildVpnScript(local: string, peer: string, psk: string): { provider: string; shell: string; script: string } {
  const localCidr = DEFAULT_CIDR[local] ?? '10.0.0.0/16';
  const peerCidr = DEFAULT_CIDR[peer] ?? '10.99.0.0/16';

  if (local === 'azure') {
    return {
      provider: 'azure', shell: 'Azure Cloud Shell',
      script: `# Azure side of VPN to ${peer.toUpperCase()} — run in Azure Cloud Shell
RG="mcmf-provisioned"; LOC="eastasia"; VNET="<your-vnet>"
PEER_GW_IP="<${peer}-gateway-public-ip>"      # fill after the ${peer} gateway exists
PEER_CIDR="${peerCidr}"
PSK="${psk}"
az network vnet subnet create -g $RG --vnet-name $VNET -n GatewaySubnet --address-prefixes 10.20.255.0/27
az network public-ip create -g $RG -n mcmf-vpn-gw-ip --sku Standard --allocation-method Static
az network vnet-gateway create -g $RG -n mcmf-vpn-gw --vnet $VNET --public-ip-address mcmf-vpn-gw-ip \\
  --gateway-type Vpn --vpn-type RouteBased --sku VpnGw1 --no-wait    # ~30-45 min
az network local-gateway create -g $RG -n ${peer}-lgw --gateway-ip-address $PEER_GW_IP --local-address-prefixes $PEER_CIDR
az network vpn-connection create -g $RG -n to-${peer} --vnet-gateway1 mcmf-vpn-gw --local-gateway2 ${peer}-lgw --shared-key $PSK`,
    };
  }
  if (local === 'aws') {
    return {
      provider: 'aws', shell: 'AWS CloudShell',
      script: `# AWS side of VPN to ${peer.toUpperCase()} — run in AWS CloudShell
VPC_ID="<your-vpc-id>"
PEER_GW_IP="<${peer}-gateway-public-ip>"      # fill after the ${peer} gateway exists
PEER_CIDR="${peerCidr}"
PSK="${psk}"
VGW=$(aws ec2 create-vpn-gateway --type ipsec.1 --query VpnGateway.VpnGatewayId --output text)
aws ec2 attach-vpn-gateway --vpn-gateway-id $VGW --vpc-id $VPC_ID
CGW=$(aws ec2 create-customer-gateway --type ipsec.1 --public-ip $PEER_GW_IP --bgp-asn 65000 --query CustomerGateway.CustomerGatewayId --output text)
aws ec2 create-vpn-connection --type ipsec.1 --customer-gateway-id $CGW --vpn-gateway-id $VGW \\
  --options "{\\"StaticRoutesOnly\\":true,\\"TunnelOptions\\":[{\\"PreSharedKey\\":\\"$PSK\\"}]}"
# then: aws ec2 create-vpn-connection-route --destination-cidr-block $PEER_CIDR --vpn-connection-id <id>`,
    };
  }
  return {
    provider: 'gcp', shell: 'GCP Cloud Shell',
    script: `# GCP side of VPN to ${peer.toUpperCase()} — run in Google Cloud Shell
NETWORK="<your-vpc>"; REGION="us-central1"
PEER_GW_IP="<${peer}-gateway-public-ip>"      # fill after the ${peer} gateway exists
PEER_CIDR="${peerCidr}"; PSK="${psk}"
gcloud compute addresses create mcmf-vpn-ip --region $REGION
gcloud compute target-vpn-gateways create mcmf-vpn-gw --network $NETWORK --region $REGION
IP=$(gcloud compute addresses describe mcmf-vpn-ip --region $REGION --format='value(address)')
for r in esp udp500 udp4500; do :; done   # forwarding rules for ESP/500/4500 (see docs)
gcloud compute vpn-tunnels create to-${peer} --peer-address $PEER_GW_IP --shared-secret "$PSK" \\
  --target-vpn-gateway mcmf-vpn-gw --region $REGION --ike-version 2 --local-traffic-selector ${localCidr} --remote-traffic-selector $PEER_CIDR`,
  };
}
