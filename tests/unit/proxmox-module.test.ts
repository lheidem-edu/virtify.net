import { describe, expect, it } from "vitest";
import {
    buildHostname,
    configParams,
    isPowerAction,
    proxmoxConfigSchema,
    proxmoxModule,
    proxmoxServerSchema,
} from "@/server/provisioning/proxmox/module";
import {
    freeMemoryBytes,
    NoCapacityError,
    selectNode,
} from "@/server/provisioning/proxmox/nodes";
import {
    assertAddress,
    generatePassword,
    ipConfigValue,
    nameserverValue,
    ProvisioningInputError,
    parseSshKeys,
    toHostLabel,
    toHostname,
    toRdns,
} from "@/server/provisioning/proxmox/sanitize";
import { fakeProxmox } from "../helpers/proxmox";

/**
 * The pure parts of the Proxmox module: what a hostname becomes, what a
 * cloud-init parameter looks like, and which node a machine goes on.
 *
 * Everything a customer can influence lands here first, because every one of
 * these values travels into a guest's `/etc/hostname`, its
 * `authorized_keys` and a Proxmox API parameter — three different escaping
 * regimes, of which the only one worth relying on is "the value was never
 * dangerous".
 */

describe("hostnames", () => {
    it("keeps the German letters people actually type", () => {
        expect(toHostLabel("Mein Größter Server", "vm")).toBe(
            "mein-groesster-server",
        );
    });

    it("drops everything a shell or an API would read as punctuation", () => {
        expect(toHostLabel("web;rm -rf /", "vm")).toBe("web-rm-rf");
        expect(toHostLabel("a&b|c`d$e", "vm")).toBe("a-b-c-d-e");
        expect(toHostLabel("a,b", "vm")).toBe("a-b");
    });

    it("never leaves a leading or trailing hyphen", () => {
        expect(toHostLabel("--web--", "vm")).toBe("web");
        expect(toHostLabel("!!!web!!!", "vm")).toBe("web");
    });

    it("falls back rather than producing an empty hostname", () => {
        // An empty name is a VM Proxmox will not create and an error the
        // customer cannot act on.
        expect(toHostLabel("!!!", "vm-101")).toBe("vm-101");
        expect(toHostLabel("", "vm-101")).toBe("vm-101");
    });

    it("keeps a label inside 63 bytes and still never ends in a hyphen", () => {
        const label = toHostLabel(`${"a".repeat(62)}-bbbb`, "vm");

        expect(label.length).toBeLessThanOrEqual(63);
        expect(label.endsWith("-")).toBe(false);
    });

    it("lets dots through as the separator and nothing else", () => {
        expect(toHostname("web.example.net", "vm")).toBe("web.example.net");
        expect(toHostname("web..example", "vm")).toBe("web.example");
    });

    it("builds a hostname from the pattern and sanitises the result", () => {
        expect(
            buildHostname("{label}-{id}", {
                label: "VPS M (1/2)",
                vmid: "101",
            }),
        ).toBe("vps-m-1-2-101");
    });

    it("falls back to the VMID when the pattern yields nothing usable", () => {
        expect(buildHostname("!!!", { label: "???", vmid: "101" })).toBe(
            "vm-101",
        );
    });
});

describe("SSH keys", () => {
    const ED25519 =
        "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIDummyKeyDataHere maria@example.net";

    it("accepts the algorithms a hoster actually sees", () => {
        expect(parseSshKeys(ED25519)).toEqual([ED25519]);
        expect(
            parseSshKeys("ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABgQ== bob"),
        ).toHaveLength(1);
    });

    it("refuses a private key rather than installing it", () => {
        expect(() =>
            parseSshKeys(
                "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaA==\n-----END OPENSSH PRIVATE KEY-----",
            ),
        ).toThrow(ProvisioningInputError);
    });

    /**
     * Refused, not stripped. A value trimmed into shape is a value the
     * customer cannot tell is wrong — they pasted two keys and would have
     * got one.
     */
    it("refuses a line that is not a public key", () => {
        expect(() => parseSshKeys(`${ED25519}\nnot-a-key`)).toThrow(
            ProvisioningInputError,
        );
    });

    it("takes several keys and ignores comments and blank lines", () => {
        expect(
            parseSshKeys(`# maria\n${ED25519}\n\n${ED25519}\n`),
        ).toHaveLength(2);
    });

    it("caps how many may be installed", () => {
        expect(() =>
            parseSshKeys(Array.from({ length: 11 }, () => ED25519).join("\n")),
        ).toThrow(/Höchstens zehn/);
    });
});

describe("cloud-init values", () => {
    it("writes ipconfig0 the way Proxmox spells it", () => {
        expect(
            ipConfigValue([
                {
                    family: "ipv4",
                    address: "192.0.2.17",
                    prefixLength: 24,
                    gateway: "192.0.2.1",
                },
            ]),
        ).toBe("ip=192.0.2.17/24,gw=192.0.2.1");
    });

    it("uses ip6/gw6 for IPv6 and joins both families with a comma", () => {
        expect(
            ipConfigValue([
                {
                    family: "ipv4",
                    address: "192.0.2.17",
                    prefixLength: 24,
                    gateway: "192.0.2.1",
                },
                {
                    family: "ipv6",
                    address: "2001:db8::2",
                    prefixLength: 64,
                    gateway: "2001:db8::1",
                },
            ]),
        ).toBe(
            "ip=192.0.2.17/24,gw=192.0.2.1,ip6=2001:db8::2/64,gw6=2001:db8::1",
        );
    });

    /**
     * The commas and the slash are the grammar of this parameter. They may
     * only come from the builder, never from a value.
     */
    it("refuses an address with a comma in it outright", () => {
        expect(() =>
            ipConfigValue([
                {
                    family: "ipv4",
                    address: "192.0.2.17,gw=10.0.0.1",
                    prefixLength: 24,
                    gateway: null,
                },
            ]),
        ).toThrow(ProvisioningInputError);
    });

    it("refuses a prefix outside the family's range", () => {
        expect(() =>
            ipConfigValue([
                {
                    family: "ipv4",
                    address: "192.0.2.17",
                    prefixLength: 64,
                    gateway: null,
                },
            ]),
        ).toThrow(/zwischen 0 und 32/);
    });

    it("refuses a gateway that is not an address", () => {
        expect(() =>
            ipConfigValue([
                {
                    family: "ipv4",
                    address: "192.0.2.17",
                    prefixLength: 24,
                    gateway: "gateway.example.net",
                },
            ]),
        ).toThrow(ProvisioningInputError);
    });

    it("dedupes nameservers, caps them at three and refuses a name", () => {
        expect(nameserverValue(["9.9.9.9", "9.9.9.9", "1.1.1.1"])).toBe(
            "9.9.9.9 1.1.1.1",
        );
        expect(
            nameserverValue(["1.1.1.1", "8.8.8.8", "9.9.9.9", "4.4.4.4"]),
        ).toBe("1.1.1.1 8.8.8.8 9.9.9.9");
        expect(() => nameserverValue(["dns.example.net"])).toThrow(
            ProvisioningInputError,
        );
    });

    it("rejects an IPv6 address with a slash or a comma", () => {
        expect(() => assertAddress("2001:db8::2/64", "ipv6")).toThrow();
        expect(() => assertAddress("2001:db8::2,x", "ipv6")).toThrow();
        expect(assertAddress("2001:DB8::2", "ipv6")).toBe("2001:db8::2");
    });

    /**
     * Proxmox decodes `sshkeys` once itself, so the blob has to arrive
     * already URL-encoded. Left as a raw newline, every key after the first
     * is lost.
     */
    it("URL-encodes the SSH keys, because Proxmox decodes them once", () => {
        const params = configParams({
            config: proxmoxConfigSchema.parse({}),
            server: proxmoxServerSchema.parse({
                apiUrl: "https://pve.example.net:8006",
                templateVmid: "9000",
                templateNode: "pve1",
            }),
            hostname: "vps-101",
            password: "hunter2hunter2hunter2",
            sshKeys: ["ssh-ed25519 AAA a", "ssh-ed25519 BBB b"],
            addresses: [],
        });

        expect(params.sshkeys).toBe(
            encodeURIComponent("ssh-ed25519 AAA a\nssh-ed25519 BBB b"),
        );
        expect(String(params.sshkeys)).not.toContain("\n");
    });

    it("leaves cipassword out entirely when there is none", () => {
        const params = configParams({
            config: proxmoxConfigSchema.parse({}),
            server: proxmoxServerSchema.parse({
                apiUrl: "https://pve.example.net:8006",
                templateVmid: "9000",
                templateNode: "pve1",
            }),
            hostname: "vps-101",
            password: null,
            sshKeys: [],
            addresses: [],
        });

        expect(params).not.toHaveProperty("cipassword");
    });

    it("tags the bridge when the server names a VLAN", () => {
        const params = configParams({
            config: proxmoxConfigSchema.parse({}),
            server: proxmoxServerSchema.parse({
                apiUrl: "https://pve.example.net:8006",
                templateVmid: "9000",
                templateNode: "pve1",
                bridge: "vmbr1",
                vlanTag: 42,
            }),
            hostname: "vps-101",
            password: null,
            sshKeys: [],
            addresses: [],
        });

        expect(params.net0).toBe("virtio,bridge=vmbr1,tag=42");
    });
});

describe("rDNS", () => {
    it("takes a fully qualified name and nothing else", () => {
        expect(toRdns("VPS-17.Virtify.net")).toBe("vps-17.virtify.net");
        expect(toRdns("  ")).toBeNull();
        expect(() => toRdns("vps17")).toThrow(ProvisioningInputError);
    });
});

describe("passwords", () => {
    it("avoids look-alike characters a person has to read off a screen", () => {
        const password = generatePassword(200);

        expect(password).toHaveLength(200);
        expect(password).not.toMatch(/[0O1lI]/);
    });
});

describe("node selection", () => {
    const node = (over: Partial<Parameters<typeof selectNode>[0][number]>) => ({
        node: "pve1",
        status: "online",
        maxmem: 64 * 1024 ** 3,
        mem: 8 * 1024 ** 3,
        maxdisk: 100 * 1024 ** 3,
        disk: 30 * 1024 ** 3,
        maxcpu: 32,
        cpu: 0.2,
        ...over,
    });

    it("keeps a tenth of the memory back", () => {
        // 64 GiB physical, 8 GiB in use, 10 % headroom → 49.6 GiB free.
        expect(freeMemoryBytes(node({}))).toBeCloseTo(
            64 * 1024 ** 3 * 0.9 - 8 * 1024 ** 3,
            -6,
        );
    });

    it("picks the emptiest node rather than the first that fits", () => {
        // First-fit would fill pve1 to its margin and only then start on
        // pve2, which puts every machine ordered in one afternoon on one host.
        const placement = selectNode(
            [
                node({ node: "pve1", mem: 50 * 1024 ** 3 }),
                node({ node: "pve2", mem: 4 * 1024 ** 3 }),
            ],
            { memoryMiB: 2048, cores: 2 },
        );

        expect(placement.node).toBe("pve2");
    });

    it("skips a node that is not online", () => {
        const placement = selectNode(
            [
                node({ node: "pve1", status: "offline", mem: 0 }),
                node({ node: "pve2", mem: 32 * 1024 ** 3 }),
            ],
            { memoryMiB: 2048, cores: 2 },
        );

        expect(placement.node).toBe("pve2");
    });

    /**
     * A node that reports no cores answered the API before it had finished
     * starting. Placing on it is a machine that will not boot.
     */
    it("skips a node that reports no cores at all", () => {
        expect(() =>
            selectNode([node({ maxcpu: 0 })], { memoryMiB: 1024, cores: 1 }),
        ).toThrow(NoCapacityError);
    });

    it("refuses more vCPUs than the host has threads", () => {
        expect(() =>
            selectNode([node({ maxcpu: 8 })], { memoryMiB: 1024, cores: 16 }),
        ).toThrow(NoCapacityError);
    });

    it("refuses when no node has the memory, margin included", () => {
        // 64 GiB with 60 GiB used: 0 free after the 10 % margin.
        expect(() =>
            selectNode([node({ mem: 60 * 1024 ** 3 })], {
                memoryMiB: 4096,
                cores: 1,
            }),
        ).toThrow(NoCapacityError);
    });

    it("honours an allow list and a deny list", () => {
        const nodes = [node({ node: "pve1" }), node({ node: "pve2" })];

        expect(
            selectNode(
                nodes,
                { memoryMiB: 1024, cores: 1 },
                { allow: ["pve2"] },
            ).node,
        ).toBe("pve2");
        expect(
            selectNode(nodes, { memoryMiB: 1024, cores: 1 }, { deny: ["pve1"] })
                .node,
        ).toBe("pve2");
    });

    /**
     * Disk is deliberately not part of the decision: `maxdisk` on a node is
     * the hypervisor's root filesystem, not the storage a VM is cloned onto.
     */
    it("ignores the node's own root filesystem being full", () => {
        const placement = selectNode([node({ disk: 99 * 1024 ** 3 })], {
            memoryMiB: 1024,
            cores: 1,
        });

        expect(placement.node).toBe("pve1");
    });
});

describe("the module's own schemas", () => {
    it("accepts an empty product configuration and fills the defaults", () => {
        // A product carries `{}` the moment its module is switched.
        expect(proxmoxConfigSchema.parse({})).toMatchObject({
            cores: 1,
            memoryMiB: 1024,
            diskGiB: 20,
            ipv4Count: 1,
            osUser: "root",
            onboot: true,
        });
    });

    it("refuses a server without an https API address", () => {
        expect(() =>
            proxmoxServerSchema.parse({
                apiUrl: "http://pve.example.net:8006",
                templateVmid: "9000",
                templateNode: "pve1",
            }),
        ).toThrow();
    });

    it("refuses a bridge or a disk bus that is not one", () => {
        expect(() =>
            proxmoxServerSchema.parse({
                apiUrl: "https://pve.example.net:8006",
                templateVmid: "9000",
                templateNode: "pve1",
                bridge: "vmbr0; rm",
            }),
        ).toThrow();
        expect(() =>
            proxmoxServerSchema.parse({
                apiUrl: "https://pve.example.net:8006",
                templateVmid: "9000",
                templateNode: "pve1",
                diskBus: "nvme9000",
            }),
        ).toThrow();
    });

    it("refuses an OS user that is not a Unix name", () => {
        expect(() =>
            proxmoxConfigSchema.parse({ osUser: "root; id" }),
        ).toThrow();
    });

    it("has lockOnSuspend off by default, because it needs root@pam", () => {
        const server = proxmoxServerSchema.parse({
            apiUrl: "https://pve.example.net:8006",
            templateVmid: "9000",
            templateNode: "pve1",
        });

        expect(server.lockOnSuspend).toBe(false);
    });
});

describe("the module's surface", () => {
    it("publishes the actions a customer may press, and nothing more", () => {
        const ids = (proxmoxModule.clientActions ?? []).map(
            (action) => action.id,
        );

        expect(ids).toEqual([
            "start",
            "shutdown",
            "reboot",
            "stop",
            "reinstall",
        ]);
        // Neither suspending nor tearing down is on a customer's list.
        expect(ids).not.toContain("suspend");
        expect(ids).not.toContain("terminate");
    });

    it("marks the two that lose data as destructive", () => {
        const destructive = (proxmoxModule.clientActions ?? [])
            .filter((action) => action.destructive)
            .map((action) => action.id);

        expect(destructive).toEqual(["stop", "reinstall"]);
    });

    it("knows which power words it accepts", () => {
        expect(isPowerAction("reboot")).toBe(true);
        expect(isPowerAction("destroy")).toBe(false);
        expect(isPowerAction(undefined)).toBe(false);
    });

    it("reports a working cluster and names the template it found", async () => {
        const fake = fakeProxmox();

        const check = await proxmoxModule.testConnection?.({
            config: proxmoxServerSchema.parse({
                apiUrl: "https://pve.example.net:8006",
                templateVmid: "9000",
                templateNode: "pve1",
            }),
            credentials: {
                tokenId: "panel@pve!billing",
                tokenSecret: "s3cret-uuid-value",
            },
            fetchImpl: fake.fetchImpl,
        });

        expect(check?.ok).toBe(true);
        expect(check?.detail).toContain("Vorlage 9000");
    });

    /**
     * "The token works" is not the question the operator is asking. "Will an
     * order go through" is, and a missing template is the way it most often
     * does not.
     */
    it("warns when the template is not there, while still reporting ok", async () => {
        const fake = fakeProxmox({ vms: [] });

        const check = await proxmoxModule.testConnection?.({
            config: proxmoxServerSchema.parse({
                apiUrl: "https://pve.example.net:8006",
                templateVmid: "9000",
                templateNode: "pve1",
            }),
            credentials: {
                tokenId: "panel@pve!billing",
                tokenSecret: "s3cret-uuid-value",
            },
            fetchImpl: fake.fetchImpl,
        });

        expect(check?.ok).toBe(true);
        expect(check?.detail).toContain("gibt es nicht");
    });

    it("says so plainly when there is no token at all", async () => {
        const check = await proxmoxModule.testConnection?.({
            config: proxmoxServerSchema.parse({
                apiUrl: "https://pve.example.net:8006",
                templateVmid: "9000",
                templateNode: "pve1",
            }),
            credentials: {},
        });

        expect(check?.ok).toBe(false);
        expect(check?.detail).toContain("kein vollständiger API-Token");
    });
});

describe("ipconfig0 carries one address per family", () => {
    function withAddresses(
        addresses: {
            family: "ipv4" | "ipv6";
            address: string;
            prefixLength: number;
            gateway: string | null;
        }[],
    ) {
        return configParams({
            config: proxmoxConfigSchema.parse({}),
            server: proxmoxServerSchema.parse({
                apiUrl: "https://pve.example.net:8006",
                templateVmid: "9000",
                templateNode: "pve1",
            }),
            hostname: "vps-101",
            password: null,
            sshKeys: [],
            addresses: addresses.map((entry, index) => ({
                id: `ipaddr_${index}`,
                poolId: "ippool_1",
                nameservers: [],
                rdns: null,
                ...entry,
            })),
        });
    }

    /**
     * `ipconfig0` belongs to `net0` and its grammar is one `ip=` and one
     * `ip6=`. Built from every assigned address, a product ordering two
     * IPv4s sent `ip=…,gw=…,ip=…,gw=…`, which PVE refuses with `parameter
     * verification failed` — so that product could not be provisioned at
     * all, on any attempt, while the second address was held by a machine
     * that was never made.
     */
    it("emits one ip= and one gw=, however many addresses are assigned", () => {
        const params = withAddresses([
            {
                family: "ipv4",
                address: "192.0.2.10",
                prefixLength: 24,
                gateway: "192.0.2.1",
            },
            {
                family: "ipv4",
                address: "192.0.2.11",
                prefixLength: 24,
                gateway: "192.0.2.1",
            },
        ]);

        expect(params.ipconfig0).toBe("ip=192.0.2.10/24,gw=192.0.2.1");
        expect(String(params.ipconfig0).match(/\bip=/g)).toHaveLength(1);
    });

    it("still carries one of each family together", () => {
        const params = withAddresses([
            {
                family: "ipv4",
                address: "192.0.2.10",
                prefixLength: 24,
                gateway: "192.0.2.1",
            },
            {
                family: "ipv6",
                address: "2001:db8::2",
                prefixLength: 64,
                gateway: "2001:db8::1",
            },
        ]);

        expect(params.ipconfig0).toBe(
            "ip=192.0.2.10/24,gw=192.0.2.1,ip6=2001:db8::2/64,gw6=2001:db8::1",
        );
    });
});

describe("one address, one spelling", () => {
    /**
     * The unique index on `(pool_id, address)` compares text, so an
     * operator pasting a range twice in two notations would get two rows
     * for one address — and the pool would hand it to two customers.
     */
    it("canonicalises IPv6 so the same address cannot be added twice", () => {
        expect(
            assertAddress("2001:0db8:0000:0000:0000:0000:0000:0001", "ipv6"),
        ).toBe("2001:db8::1");
        expect(assertAddress("2001:DB8::0001", "ipv6")).toBe("2001:db8::1");
        expect(assertAddress("2001:db8::1", "ipv6")).toBe("2001:db8::1");
    });

    it("still refuses something that is not an address", () => {
        expect(() => assertAddress("2001:db8::1,gw=::1", "ipv6")).toThrow(
            ProvisioningInputError,
        );
    });
});
