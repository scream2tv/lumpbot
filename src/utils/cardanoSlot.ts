export type CardanoNetworkId = 'mainnet' | 'preprod' | 'preview';

interface NetworkConstants {
  byronGenesisUnix: number;
  byronSlotSeconds: number;
  shelleyStartSlot: number;
  shelleyStartUnix: number;
  shelleySlotSeconds: number;
}

const NETWORKS: Record<CardanoNetworkId, NetworkConstants> = {
  mainnet: {
    byronGenesisUnix: 1506203091,
    byronSlotSeconds: 20,
    shelleyStartSlot: 4492800,
    shelleyStartUnix: 1596059091,
    shelleySlotSeconds: 1,
  },
  preprod: {
    byronGenesisUnix: 1654041600,
    byronSlotSeconds: 20,
    shelleyStartSlot: 86400,
    shelleyStartUnix: 1655769600,
    shelleySlotSeconds: 1,
  },
  preview: {
    byronGenesisUnix: 1666656000,
    byronSlotSeconds: 1,
    shelleyStartSlot: 0,
    shelleyStartUnix: 1666656000,
    shelleySlotSeconds: 1,
  },
};

export function slotToUnix(slot: number, network: CardanoNetworkId = 'mainnet'): number {
  const c = NETWORKS[network];
  if (slot < c.shelleyStartSlot) {
    return c.byronGenesisUnix + slot * c.byronSlotSeconds;
  }
  return c.shelleyStartUnix + (slot - c.shelleyStartSlot) * c.shelleySlotSeconds;
}

export function unixToSlot(unixSeconds: number, network: CardanoNetworkId = 'mainnet'): number {
  const c = NETWORKS[network];
  if (unixSeconds < c.shelleyStartUnix) {
    return Math.max(0, Math.floor((unixSeconds - c.byronGenesisUnix) / c.byronSlotSeconds));
  }
  return c.shelleyStartSlot + Math.floor((unixSeconds - c.shelleyStartUnix) / c.shelleySlotSeconds);
}
