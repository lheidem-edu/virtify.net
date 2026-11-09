# Proxmox VE einrichten

**Für diese Installation gibt es keinen Proxmox-Cluster, und es wurde auch nicht nach
Zugangsdaten gesucht.** Alles im Code ist gegen die dokumentierte PVE-API geschrieben
und gegen handgeschriebene Antworten getestet (`tests/helpers/proxmox.ts`). Dieses
Dokument sagt, was ein Administrator im Cluster tun muss, damit es damit redet.

Sobald es echte Zugangsdaten gibt, gehören sie in `/admin/settings/provisioning`. Dort
liegen sie AES-256-GCM-verschlüsselt (harte Regel 6) und werden nie wieder angezeigt.
In `.env.local` gehört nichts davon — und `.env.local` ist ohnehin gitignored.

---

## 1. Einen eigenen Benutzer anlegen

Nicht `root@pam`. Der Benutzer soll genau so viel dürfen, wie das Panel braucht, und
nicht mehr.

```bash
pveum user add panel@pve --comment "virtify.net Billing-Panel"
```

## 2. Eine Rolle mit den nötigen Rechten

```bash
pveum role add VirtifyPanel --privs "\
VM.Allocate,VM.Clone,VM.Config.CPU,VM.Config.Disk,VM.Config.Memory,\
VM.Config.Network,VM.Config.Options,VM.Config.Cloudinit,\
VM.PowerMgmt,VM.Console,VM.Audit,\
Datastore.AllocateSpace,Datastore.Audit,\
Sys.Audit,Pool.Allocate"
```

Was wofür da ist:

| Recht | Wofür |
|---|---|
| `VM.Allocate`, `VM.Clone` | Eine VM aus der Vorlage klonen und wieder abbauen. |
| `VM.Config.*` | Kerne, RAM, Datenträger, Netz und cloud-init setzen. |
| `VM.PowerMgmt` | Starten, Stoppen, Herunterfahren, Neustarten. |
| `VM.Console` | Die VNC-Konsole (`vncproxy`). |
| `VM.Audit` | Den Zustand einer VM abfragen. |
| `Datastore.AllocateSpace` | Den Datenträger des Klons anlegen und vergrößern. |
| `Sys.Audit` | `GET /nodes` — die Knotenauswahl braucht freien Arbeitsspeicher. |
| `Pool.Allocate` | Nur nötig, wenn im Panel ein Proxmox-Pool eingetragen ist. |

**Was absichtlich fehlt:** alles, was `root@pam` vorbehalten ist. Insbesondere darf
dieser Benutzer **`lock` nicht setzen**. Das ist kein Versehen — siehe Abschnitt 6.

## 3. Rolle zuweisen

Am engsten: auf den Pool, in dem die Kundenmaschinen liegen, plus Lesezugriff auf die
Knoten und den Speicher.

```bash
pveum pool add kunden
pveum acl modify /pool/kunden   --users panel@pve --roles VirtifyPanel
pveum acl modify /nodes         --users panel@pve --roles PVEAuditor
pveum acl modify /storage       --users panel@pve --roles VirtifyPanel
```

Die Vorlage muss der Benutzer klonen dürfen. Liegt sie außerhalb des Pools:

```bash
pveum acl modify /vms/9000 --users panel@pve --roles VirtifyPanel
```

## 4. Einen API-Token erzeugen

```bash
pveum user token add panel@pve billing --privsep 0
```

`--privsep 0` heißt: der Token hat die Rechte seines Benutzers. Mit `--privsep 1`
bräuchte der Token noch einmal eigene ACL-Einträge, was dieselbe Zuweisung zweimal
bedeutet.

Die Ausgabe zeigt das Secret **genau einmal**. Es gehört zusammen mit der Token-ID
(`panel@pve!billing`) in `/admin/settings/provisioning` und nirgendwo sonst.

## 5. Eine cloud-init-Vorlage bauen

Das Modul klont und setzt dann cloud-init. Die Vorlage muss also eine cloud-init-fähige
sein — ein Cloud-Image von Debian oder Ubuntu, kein von Hand installiertes System.

```bash
# Debian 13 als Beispiel
wget https://cloud.debian.org/images/cloud/trixie/latest/debian-13-genericcloud-amd64.qcow2
qm create 9000 --name debian-13-cloud --memory 1024 --cores 1 --net0 virtio,bridge=vmbr0
qm importdisk 9000 debian-13-genericcloud-amd64.qcow2 local-zfs
qm set 9000 --scsihw virtio-scsi-pci --scsi0 local-zfs:vm-9000-disk-0
qm set 9000 --ide2 local-zfs:cloudinit
qm set 9000 --boot order=scsi0
qm set 9000 --serial0 socket --vga serial0
qm set 9000 --agent enabled=1
qm template 9000
```

Zwei Dinge, die sonst Ärger machen:

- **Der Datenträger der Vorlage sollte klein sein.** Das Modul vergrößert ihn auf die
  bestellte Größe — Proxmox kann einen Datenträger nur wachsen lassen, nie
  verkleinern. Eine Vorlage mit 50 GB macht jedes 20-GB-Paket zu einem 50-GB-Paket;
  das Panel sagt das als Hinweis am Auftrag, kann es aber nicht reparieren.
- **`--serial0 socket --vga serial0`** ist das, was die Konsole bei Cloud-Images
  überhaupt etwas anzeigen lässt.

## 6. Warum Sperren nicht auf `lock` baut

Der Bauplan sagt „suspend = stop + lock“. `lock` über die API zu setzen ist auf einer
normalen Installation `root@pam` vorbehalten — also genau dem Benutzer, den dieses
Dokument *nicht* anlegt.

Gesperrt wird deshalb durch **Stoppen und Abmelden vom Hoststart** (`onboot=0`). Das
zweite ist der Teil, der zählt: ohne ihn bringt der nächste Neustart des Hosts die
Maschine eines gesperrten Kunden wieder hoch.

`lock` wird zusätzlich versucht, wenn es am Server eingeschaltet ist
(„Beim Sperren zusätzlich `lock` setzen“). Scheitert es, steht das als **Hinweis am
Auftrag**, nicht als Fehler — die Maschine ist so oder so gestoppt. Wer `lock` wirklich
will, braucht dafür einen Token mit `root@pam`-Rechten und sollte wissen, dass er dem
Panel damit den ganzen Cluster gibt.

## 7. TLS

Node vertraut dem selbst signierten Zertifikat eines Clusters nicht, und das globale
`fetch` von Node nimmt **keine** Zertifikatsoptionen pro Anfrage entgegen, ohne dass
undici als Abhängigkeit dazukäme (harte Regel 12). Es gibt deshalb bewusst keinen
Schalter „Zertifikat nicht prüfen“: der ließe sich heute nur als
`NODE_TLS_REJECT_UNAUTHORIZED=0` bauen, und das schaltet die Prüfung auch für Stripe
und Microsoft ab.

Zwei saubere Wege:

1. **Ein echtes Zertifikat** für die API-Adresse (Let's Encrypt über den ACME-Support
   von Proxmox, `Datacenter → ACME`). Das ist der empfohlene Weg.
2. **Die Cluster-CA in `NODE_EXTRA_CA_CERTS`** des Panel-Containers:

   ```
   NODE_EXTRA_CA_CERTS=/etc/ssl/certs/pve-cluster-ca.pem
   ```

   Die Datei liegt im Cluster unter `/etc/pve/pve-root-ca.pem`.

## 8. Im Panel eintragen

`/admin/settings/provisioning` → „Neuen Proxmox-Server anlegen“:

| Feld | Beispiel |
|---|---|
| API-Adresse | `https://pve1.example.net:8006` |
| Knoten der Vorlage | `pve1` |
| VMID der Vorlage | `9000` |
| Speicher | `local-zfs` (leer = wie die Vorlage) |
| Bridge | `vmbr0` |
| Datenträger | `scsi0` |
| API-Token-ID | `panel@pve!billing` |
| API-Token-Secret | das Secret aus Schritt 4 |

Dann **„Verbindung prüfen“**. Das fragt `GET /version`, `GET /nodes` *und* die Vorlage
ab — „der Token funktioniert“ ist nicht die Frage, die hier interessiert, sondern „geht
eine Bestellung durch“, und eine fehlende Vorlage ist der häufigste Grund, warum nicht.

## 9. IP-Pools

Ohne freie Adresse wird eine Leistung nicht eingerichtet — und zwar **bevor** am
Cluster irgendetwas passiert, sodass nichts halb entsteht. Pro Pool:

- Familie, Maske und Gateway
- die Nameserver, die cloud-init mitbekommt
- die Adressen selbst, als Liste

Adressen, die nicht vergeben werden sollen (das Gateway, der Hypervisor), werden als
**zurückgehalten** aufgenommen: sie stehen in der Liste, werden aber nie zugewiesen.

Eine Adresse geht **beim Abbau** zurück in den Pool, zusammen mit ihrem PTR-Eintrag —
und nur dann. Eine Sperre, ein Tarifwechsel oder eine Neuinstallation lassen sie, wo
sie ist, weil die Maschine noch da ist und darauf antwortet.

## 10. Am Produkt

`/admin/catalog/<produkt>` → Modul `Proxmox VE`, und als Moduleinstellungen z. B.:

```json
{
  "cores": 2,
  "memoryMiB": 4096,
  "diskGiB": 80,
  "ipv4Count": 1,
  "ipv6Count": 1,
  "osUser": "root",
  "hostnamePattern": "{label}-{id}",
  "onboot": true
}
```

Ein **Tarifwechsel liest diese Werte erneut** — die Maschine bekommt also die
Ausstattung des neuen Produkts, und zwar in dem Moment, in dem der Wechsel in Kraft
tritt. Kerne und Arbeitsspeicher werden bei einer laufenden VM erst mit dem nächsten
Neustart wirksam; das Panel sagt das am Auftrag.

Außerdem am Produkt: **„Automatisch bereitstellen“** (`auto_on_payment`) gegen
**„Von Hand“** (`manual`). Nur das erste richtet ohne einen Menschen ein, und auch das
erst, wenn an dem Abo nichts mehr offen ist.

---

## Was das Panel nicht tut

- **Es setzt keine PTR-Einträge im DNS.** Das Feld am Pool ist die Notiz des
  Betreibers; der Eintrag selbst entsteht beim Upstream oder im eigenen rDNS-Server.
- **Es bringt keinen Konsolen-Betrachter mit.** `vncproxy` wird abgefragt und das
  Ticket ausgegeben; ein noVNC-Client wäre eine neue Abhängigkeit (Regel 12) und ein
  eingebauter bräuchte eine eigene Websocket-Weiterleitung. Siehe
  `docs/PROGRESS.md`.
- **Es migriert keine VMs zwischen Knoten.** Der Knoten wird einmal gewählt und bleibt;
  wird eine VM im Cluster verschoben, liest das Panel den neuen Knoten beim nächsten
  Abruf nicht nach.
