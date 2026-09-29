import { DefaultNetworkConfig } from '@waku/sdk';
import { expect, test } from 'vitest';
import { routingInfoFor, wakuNetworkSettings } from '../../src/adapters/waku.ts';
import { browserRoutingInfo, browserWakuNetworkSettings } from '../../src/browser/waku-transport.ts';
import { withoutOwnedPeers } from '../../scripts/live-infra/waku-peers.ts';

const TOPIC = '/sovereign-storefront/1/live/proto';
const PUBLIC_PEER = '/dns4/node-01.do-ams3.status.im/tcp/8000/wss/p2p/16Uiu2HAmPublicPeer';
const OWNED_PEER = '/dns4/wss.agentmascot.app/tcp/443/wss/p2p/16Uiu2HAmOwned';

function fields(info: { clusterId: number; shardId: number; pubsubTopic: string }) {
  return { clusterId: info.clusterId, shardId: info.shardId, pubsubTopic: info.pubsubTopic };
}

test('absent network is DefaultNetworkConfig and seller routing matches the browser', () => {
  const seller = wakuNetworkSettings({ bootstrapPeers: [PUBLIC_PEER] });
  const browser = browserWakuNetworkSettings({ bootstrapPeers: [PUBLIC_PEER] });
  expect(seller.networkConfig).toBe(DefaultNetworkConfig);
  expect(seller.networkConfig).toEqual({ clusterId: 1, numShardsInCluster: 8 });
  expect(browser).toEqual(seller);
  expect(fields(browserRoutingInfo(browser, TOPIC))).toEqual(fields(routingInfoFor(seller, TOPIC)));
});

test('explicit cluster-1 shards produce the same routing on both sides', () => {
  const network = { clusterId: 1, shards: [0, 1, 2, 3, 4, 5, 6, 7] };
  const seller = wakuNetworkSettings({ network, bootstrapPeers: [PUBLIC_PEER] });
  const browser = browserWakuNetworkSettings({ network, bootstrapPeers: [PUBLIC_PEER] });
  expect(fields(routingInfoFor(seller, TOPIC))).toEqual(fields(browserRoutingInfo(browser, TOPIC)));
  const absent = wakuNetworkSettings({ bootstrapPeers: [PUBLIC_PEER] });
  expect(fields(routingInfoFor(seller, TOPIC))).toEqual(fields(routingInfoFor(absent, TOPIC)));
});

test('unknown cluster ids are rejected by the seller and the browser', () => {
  for (const clusterId of [0, 2, 99]) {
    const network = { clusterId, shards: [0] };
    expect(() => wakuNetworkSettings({ network, bootstrapPeers: [PUBLIC_PEER] })).toThrow(/unknown waku cluster/);
    expect(() => browserWakuNetworkSettings({ network, bootstrapPeers: [PUBLIC_PEER] })).toThrow(/unknown waku cluster/);
  }
});

test('owned delivery peers are excluded from the public bootstrap list', () => {
  expect(withoutOwnedPeers([OWNED_PEER, PUBLIC_PEER])).toEqual([PUBLIC_PEER]);
  expect(() => wakuNetworkSettings({ bootstrapPeers: [OWNED_PEER] })).toThrow(/agentmascot/);
});
