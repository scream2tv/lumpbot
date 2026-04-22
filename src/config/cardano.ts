import type { CardanoNetworkId } from '../utils/cardanoSlot';

export interface CardanoStackConfig {
  ogmiosWsUrl: string;
  ogmiosHealthUrl: string;
  kupoUrl: string;
  network: CardanoNetworkId;
  cardanoscanBase: string;
}

const DEFAULT_OGMIOS_WS = 'ws://cardano-wsl:8080/ogmios/';
const DEFAULT_OGMIOS_HEALTH = 'http://cardano-wsl:8080/ogmios/health';
const DEFAULT_KUPO = 'http://cardano-wsl:8080/kupo/';

function optional(name: string, fallback: string): string {
  return (process.env[name] ?? fallback).trim();
}

export function loadCardanoConfig(): CardanoStackConfig {
  const network = (optional('CARDANO_NETWORK', 'mainnet') as CardanoNetworkId);
  const cardanoscanBase =
    network === 'mainnet'
      ? 'https://cardanoscan.io'
      : network === 'preprod'
        ? 'https://preprod.cardanoscan.io'
        : 'https://preview.cardanoscan.io';

  return {
    ogmiosWsUrl: optional('OGMIOS_WS_URL', DEFAULT_OGMIOS_WS),
    ogmiosHealthUrl: optional('OGMIOS_HEALTH_URL', DEFAULT_OGMIOS_HEALTH),
    kupoUrl: optional('KUPO_URL', DEFAULT_KUPO).replace(/\/$/, ''),
    network,
    cardanoscanBase,
  };
}
