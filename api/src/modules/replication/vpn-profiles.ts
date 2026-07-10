// Interoperability presets for IPsec site-to-site with every common gateway/firewall. Each profile gives
// vendor-compatible IKE + ESP proposals (multiple, so negotiation succeeds), the ports to open, a
// requirement checklist for that remote gateway, and how to mirror the tunnel on the far side. Proposals
// use strongSwan syntax; the same crypto maps 1:1 onto AWS/Azure/GCP/Cisco/Fortinet/PAN/pfSense/MikroTik.

export interface VpnProfile {
  key: string;
  label: string;
  cloud?: boolean;
  ike: string; // IKE (phase-1) proposals — strongSwan syntax
  esp: string; // ESP/child (phase-2) proposals
  ports: string[]; // firewall openings both ends need
  reqs: string[]; // what to create/allow on the REMOTE gateway of this type
  mirror: string[]; // the mirrored phase-1/2 params to set on the far gateway
}

// Broadly-interoperable crypto: AES-GCM (modern) first, then AES-CBC/SHA256/DH14, then a legacy fallback.
const IKE_MODERN = 'aes256gcm16-prfsha384-ecp384,aes256-sha256-modp2048,aes256-sha1-modp1024';
const ESP_MODERN = 'aes256gcm16-ecp384,aes256-sha256-modp2048,aes256-sha1-modp1024';

export const VPN_PROFILES: Record<string, VpnProfile> = {
  strongswan: {
    key: 'strongswan', label: 'Linux strongSwan / MCMF-managed', ike: IKE_MODERN, esp: ESP_MODERN,
    ports: ['UDP 500 (IKE)', 'UDP 4500 (NAT-T)', 'IP proto 50 (ESP) if no NAT'],
    reqs: ['MCMF configures both ends automatically — nothing to do on the peer.'],
    mirror: ['Handled by MCMF (symmetric swanctl on both hosts).'],
  },
  aws: {
    key: 'aws', label: 'AWS (VPN Gateway / Transit Gateway)', cloud: true,
    ike: 'aes256-sha256-modp2048,aes256-sha1-modp1024', esp: 'aes256-sha256-modp2048,aes256-sha1-modp1024',
    ports: ['UDP 500 + 4500 in the Security Group & NACL', 'IP proto 50 (ESP)'],
    reqs: [
      'Create a Customer Gateway → peer IP = the OTHER side\'s public IP, routing = static (or BGP).',
      'Create a Virtual Private Gateway (attach to the VPC) OR a Transit Gateway.',
      'Create a Site-to-Site VPN Connection (CGW + VGW/TGW), static routes = the remote subnet(s).',
      'Enable route propagation (or add a static route) for the remote subnet in the VPC route table.',
      'Security Group + NACL: allow UDP 500/4500 + ESP from the peer public IP.',
      'If you instead terminate on a strongSwan VM: disable source/dest check + give it an Elastic IP.',
    ],
    mirror: ['IKEv2, PSK auth', 'AES-256 / SHA-256 / DH group 14 (or 2 for classic)', 'PFS DH14, tunnel mode', 'DPD on, rekey ~8h/1h'],
  },
  azure: {
    key: 'azure', label: 'Azure (VPN Gateway)', cloud: true,
    ike: 'aes256-sha256-modp2048,aes256-sha256-modp1024', esp: 'aes256-sha256-modp2048,aes256-sha256-modp1024',
    ports: ['UDP 500 + 4500 in the NSG', 'IP proto 50 (ESP)'],
    reqs: [
      'Create a VPN Gateway (route-based = IKEv2; policy-based = IKEv1, single subnet pair).',
      'Create a Local Network Gateway → gateway IP = the OTHER side\'s public IP, address space = remote subnet(s).',
      'Create a Connection (VPN Gateway ↔ Local Network Gateway), auth = the shared PSK.',
      'For custom crypto, set an IPsec/IKE Policy on the Connection to match (AES256/SHA256/DH14/PFS14).',
      'NSG: allow UDP 500/4500 + ESP from the peer public IP; the VPN Gateway subnet route is automatic.',
      'If terminating on a Linux VM instead: enable IP forwarding on the NIC + a UDR for the remote subnet.',
    ],
    mirror: ['IKEv2 (route-based) or IKEv1 (policy-based)', 'AES-256 / SHA-256 / DH14', 'PFS14, tunnel mode'],
  },
  gcp: {
    key: 'gcp', label: 'GCP (Cloud VPN / HA VPN)', cloud: true,
    ike: 'aes256gcm16-prfsha256-ecp256,aes256-sha256-modp2048', esp: 'aes256gcm16-ecp256,aes256-sha256-modp2048',
    ports: ['UDP 500 + 4500 firewall rule', 'IP proto 50 (ESP)'],
    reqs: [
      'Create a Cloud VPN gateway (HA VPN recommended, or Classic VPN).',
      'Create a Peer VPN gateway → interface IP = the OTHER side\'s public IP.',
      'Create a VPN tunnel (IKEv2, the shared PSK), routing = static routes or Cloud Router/BGP.',
      'Add static routes (or advertise via BGP) for the remote subnet(s).',
      'VPC firewall: allow udp 500,4500 + protocol 50 (esp) from the peer public IP.',
      'If terminating on a Compute VM instead: set --can-ip-forward + a route with next-hop = that VM.',
    ],
    mirror: ['IKEv2, PSK auth', 'AES-256-GCM or AES-256 / SHA-256', 'PFS group 14+ (ecp256/modp2048)', 'tunnel mode'],
  },
  'cisco-asa': {
    key: 'cisco-asa', label: 'Cisco ASA (firewall)', ike: 'aes256-sha256-modp2048', esp: 'aes256-sha256-modp2048',
    ports: ['UDP 500 + 4500', 'IP proto 50 (ESP)'],
    reqs: [
      'crypto ikev2 policy → aes-256, sha256, group 14, prf sha256, lifetime 86400.',
      'tunnel-group <peerIP> type ipsec-l2l + ikev2 remote/local pre-shared-key <PSK>.',
      'crypto ipsec ikev2 ipsec-proposal → protocol esp encryption aes-256, integrity sha-256.',
      'crypto map: match address <ACL of remote↔local subnets>, set peer <peerIP>, set pfs group14.',
      'ACL permits the interesting traffic (local subnet ↔ remote subnet); NAT-exempt that traffic.',
      'Open UDP 500/4500 + ESP on the outside interface / upstream firewall.',
    ],
    mirror: ['IKEv2, PSK', 'AES-256 / SHA-256 / DH14', 'PFS group14', 'lifetime IKE 86400 / IPsec 3600'],
  },
  'cisco-ios': {
    key: 'cisco-ios', label: 'Cisco IOS / CSR router', ike: 'aes256-sha256-modp2048', esp: 'aes256-sha256-modp2048',
    ports: ['UDP 500 + 4500', 'IP proto 50 (ESP)'],
    reqs: [
      'crypto ikev2 proposal → encryption aes-cbc-256, integrity sha256, group 14.',
      'crypto ikev2 keyring + peer <peerIP> + pre-shared-key <PSK>; crypto ikev2 profile matches identity address.',
      'crypto ipsec transform-set → esp-aes 256 esp-sha256-hmac, mode tunnel.',
      'Route-based (IPsec VTI, tunnel interface, ip route) OR crypto map with an ACL of the subnets.',
      'Open UDP 500/4500 + ESP; add a route for the remote subnet.',
    ],
    mirror: ['IKEv2, PSK', 'AES-256 / SHA-256 / DH14', 'VTI or crypto-map', 'PFS14'],
  },
  fortinet: {
    key: 'fortinet', label: 'Fortinet FortiGate', ike: IKE_MODERN, esp: ESP_MODERN,
    ports: ['UDP 500 + 4500', 'IP proto 50 (ESP)'],
    reqs: [
      'VPN → IPsec Tunnels → Custom: phase1-interface, IKEv2, remote-gw = peer public IP, PSK.',
      'phase1 proposal aes256-sha256, DH group 14; phase2-interface with src/dst subnets, PFS group 14.',
      'Add a static route for the remote subnet out the IPsec interface.',
      'Firewall policies both directions (local ↔ IPsec interface) for the subnets.',
      'Allow UDP 500/4500 + ESP inbound on the WAN interface.',
    ],
    mirror: ['IKEv2, PSK', 'AES-256 / SHA-256 / DH14', 'PFS group14', 'phase1+phase2 subnets match'],
  },
  paloalto: {
    key: 'paloalto', label: 'Palo Alto (PAN-OS)', ike: IKE_MODERN, esp: ESP_MODERN,
    ports: ['UDP 500 + 4500', 'IP proto 50 (ESP)'],
    reqs: [
      'Network → IKE Gateway: peer IP = the other side\'s public IP, IKEv2, PSK.',
      'IKE Crypto + IPSec Crypto profiles: AES-256, SHA-256, DH group 14, PFS group 14.',
      'Network → IPSec Tunnel bound to a tunnel interface (proxy-IDs = local/remote subnets).',
      'Virtual Router: static route for the remote subnet via the tunnel interface.',
      'Security policy + zone for the tunnel; allow UDP 500/4500 + ESP inbound.',
    ],
    mirror: ['IKEv2, PSK', 'AES-256 / SHA-256 / DH14', 'PFS group14', 'proxy-IDs = subnet pair'],
  },
  pfsense: {
    key: 'pfsense', label: 'pfSense / OPNsense', ike: IKE_MODERN, esp: ESP_MODERN,
    ports: ['UDP 500 + 4500', 'IP proto 50 (ESP)'],
    reqs: [
      'VPN → IPsec → Tunnels: Phase 1 = IKEv2, peer = the other side\'s public IP, PSK.',
      'Phase 1 crypto AES-256 / SHA-256 / DH14; Phase 2 = local + remote subnets, AES-256/SHA-256, PFS14.',
      'Firewall → Rules → IPsec: allow the subnet traffic; WAN: allow UDP 500/4500 + ESP.',
      '(pfSense runs strongSwan, so it interoperates cleanly with MCMF.)',
    ],
    mirror: ['IKEv2, PSK', 'AES-256 / SHA-256 / DH14', 'PFS14', 'Phase 2 subnets match'],
  },
  mikrotik: {
    key: 'mikrotik', label: 'MikroTik RouterOS', ike: 'aes256-sha256-modp2048', esp: 'aes256-sha256-modp2048',
    ports: ['UDP 500 + 4500', 'IP proto 50 (ESP)'],
    reqs: [
      '/ip ipsec profile → hash sha256, enc-algorithm aes-256, dh-group modp2048.',
      '/ip ipsec peer → address = peer public IP, exchange-mode ike2; identity with the PSK secret.',
      '/ip ipsec proposal → auth sha256, enc aes-256-cbc, pfs-group modp2048.',
      '/ip ipsec policy → src-address = local subnet, dst-address = remote subnet, tunnel yes.',
      'Add a NAT bypass rule for the subnet traffic; open UDP 500/4500 + ESP in the firewall.',
    ],
    mirror: ['IKEv2, PSK', 'AES-256 / SHA-256 / modp2048', 'PFS modp2048', 'policy = subnet pair'],
  },
  sophos: {
    key: 'sophos', label: 'Sophos / SonicWall / other UTM', ike: IKE_MODERN, esp: ESP_MODERN,
    ports: ['UDP 500 + 4500', 'IP proto 50 (ESP)'],
    reqs: [
      'Create a site-to-site IPsec connection, IKEv2, remote gateway = peer public IP, PSK.',
      'Crypto: AES-256 / SHA-256 / DH14, PFS group 14; local + remote subnets as the policy.',
      'Add a route for the remote subnet + firewall rules both directions; allow UDP 500/4500 + ESP.',
    ],
    mirror: ['IKEv2, PSK', 'AES-256 / SHA-256 / DH14', 'PFS14'],
  },
  checkpoint: {
    key: 'checkpoint', label: 'Check Point', ike: IKE_MODERN, esp: ESP_MODERN,
    ports: ['UDP 500 + 4500', 'IP proto 50 (ESP)'],
    reqs: [
      'Define an interoperable device (peer public IP) + VPN community (star/mesh), PSK.',
      'Encryption: IKEv2, AES-256, SHA-256, DH group 14, PFS group 14.',
      'Encryption domain = local subnet; peer\'s domain = remote subnet; add access-control rules.',
      'Allow UDP 500/4500 + ESP; add a route for the remote subnet.',
    ],
    mirror: ['IKEv2, PSK', 'AES-256 / SHA-256 / DH14', 'PFS14', 'encryption domains = subnets'],
  },
  generic: {
    key: 'generic', label: 'Generic IKEv2 device', ike: IKE_MODERN, esp: ESP_MODERN,
    ports: ['UDP 500 + 4500', 'IP proto 50 (ESP)'],
    reqs: [
      'Any IKEv2 gateway works. Set: peer = the other side\'s public IP, PSK auth.',
      'Phase 1: AES-256 / SHA-256 / DH group 14. Phase 2: AES-256 / SHA-256, PFS group 14.',
      'Traffic selectors = local subnet ↔ remote subnet; add a route + firewall allow (UDP 500/4500 + ESP).',
    ],
    mirror: ['IKEv2, PSK', 'AES-256 / SHA-256 / DH14', 'PFS14', 'tunnel mode'],
  },
};

// What to open/route on side A's OWN cloud (when A is a cloud VM terminating strongSwan).
export const CLOUD_REQS: Record<string, string[]> = {
  aws: [
    'Security Group (+ NACL): allow inbound UDP 500 & 4500 and IP proto 50 (ESP) from the peer public IP.',
    'Route table: add the remote subnet → the strongSwan VM\'s ENI (or the VGW).',
    'Disable Source/Dest check on the VM\'s ENI (so it can route the tunnel traffic).',
    'Give the VM an Elastic IP (stable public IKE endpoint).',
  ],
  azure: [
    'NSG: allow inbound UDP 500 & 4500 and ESP from the peer public IP.',
    'Enable IP forwarding on the VM\'s NIC.',
    'Route table (UDR): remote subnet → the strongSwan VM (virtual appliance next hop).',
    'Assign a static Public IP to the VM.',
  ],
  gcp: [
    'VPC firewall: allow ingress udp:500,4500 and protocol 50 (esp) from the peer public IP.',
    'Set --can-ip-forward on the VM.',
    'Add a custom route: remote subnet → next-hop-instance = the strongSwan VM.',
    'Reserve a static external IP for the VM.',
  ],
  private: [
    'Perimeter firewall: allow UDP 500 & 4500 and ESP (proto 50) to/from the peer public IP.',
    'If the VM is behind NAT, forward UDP 500/4500 to it and prefer NAT-T.',
    'Add a route for the remote subnet toward the strongSwan host.',
  ],
  onprem: [
    'Perimeter firewall: allow UDP 500 & 4500 and ESP (proto 50) to/from the peer public IP.',
    'If behind NAT, forward UDP 500/4500 to the gateway and enable NAT-T.',
    'Add a route for the remote subnet toward the VPN gateway.',
  ],
};

export function vpnProfile(peerType: string): VpnProfile {
  return VPN_PROFILES[peerType] || VPN_PROFILES.generic;
}
