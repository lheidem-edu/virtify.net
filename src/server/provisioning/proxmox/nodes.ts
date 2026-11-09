import type { NodeCapacity } from "./api";

/**
 * Which node a new machine goes on.
 *
 * Pure: a list of nodes as the cluster described them plus what the machine
 * needs, and a verdict. No clock, no database, no `fetch` — so the awkward
 * cases below are unit tests with concrete numbers rather than something
 * only a real cluster could show.
 *
 * **Memory is the binding resource and nothing else is close.** A VM's cores
 * are oversubscribed as a matter of course — twenty guests with four cores
 * each on a sixteen-thread host is normal and fine — while its memory is
 * not: a node that hands out more than it has either starts swapping or has
 * the OOM killer pick a customer's database at random. So free memory is
 * what the choice is made on, and cores are checked only against the node's
 * physical count, because a guest with more vCPUs than the host has threads
 * will not start at all.
 *
 * Disk is deliberately *not* part of this. `maxdisk` on a node is the root
 * filesystem, not the storage a VM's disk is cloned onto, and treating it as
 * capacity would refuse to place a machine on a perfectly empty Ceph pool
 * because the hypervisor's own 32 GB root was three-quarters full.
 */

export type PlacementNeed = {
    /** MiB, as Proxmox counts memory. */
    memoryMiB: number;
    cores: number;
};

export type Placement = {
    node: string;
    /** Bytes free after this machine is placed. For the record on the task. */
    freeMemoryAfter: number;
};

export class NoCapacityError extends Error {
    constructor(
        message: string,
        readonly considered: number,
    ) {
        super(message);
        this.name = "NoCapacityError";
    }
}

/**
 * How much memory is unaccounted for on a node, with a margin.
 *
 * `maxmem` is the node's physical memory and `mem` is what it is using —
 * including the hypervisor itself, ZFS ARC and every running guest. The
 * margin is what keeps the last 10 % from being handed out: a node at
 * exactly 100 % is a node whose next guest cannot be started, and the
 * numbers Proxmox reports are a moment's reading rather than a reservation.
 */
export const HEADROOM = 0.1;

export function freeMemoryBytes(node: NodeCapacity): number {
    const usable = node.maxmem * (1 - HEADROOM);

    return Math.max(usable - node.mem, 0);
}

export type SelectOptions = {
    /** Only these nodes, when the operator named some. Empty means any. */
    allow?: readonly string[];
    /** Never these, whatever else is true. */
    deny?: readonly string[];
};

/**
 * The node with the most room, among those that could take the machine.
 *
 * Most-free-first rather than first-fit: first-fit fills one node to its
 * margin and then starts on the next, which puts every machine ordered in
 * one afternoon on the same host. Spreading them is what a two-node cluster
 * is for.
 */
export function selectNode(
    nodes: readonly NodeCapacity[],
    need: PlacementNeed,
    options: SelectOptions = {},
): Placement {
    const allow = options.allow ?? [];
    const deny = options.deny ?? [];
    const wanted = need.memoryMiB * 1024 * 1024;

    const candidates = nodes
        .filter((node) => node.node !== "")
        .filter((node) => node.status === "online")
        .filter((node) => allow.length === 0 || allow.includes(node.node))
        .filter((node) => !deny.includes(node.node))
        /**
         * A node that reports no cores at all is a node that answered the
         * API before it had finished starting. Placing on it is a machine
         * that will not boot; skipping it is one more pass through the
         * sweep.
         */
        .filter((node) => node.maxcpu > 0 && node.maxcpu >= need.cores)
        .filter((node) => freeMemoryBytes(node) >= wanted)
        .sort((a, b) => freeMemoryBytes(b) - freeMemoryBytes(a));

    const chosen = candidates[0];

    if (!chosen) {
        throw new NoCapacityError(
            `Kein Knoten im Cluster hat Platz für ${need.cores} Kerne und ` +
                `${need.memoryMiB} MiB Arbeitsspeicher.`,
            nodes.length,
        );
    }

    return {
        node: chosen.node,
        freeMemoryAfter: freeMemoryBytes(chosen) - wanted,
    };
}
