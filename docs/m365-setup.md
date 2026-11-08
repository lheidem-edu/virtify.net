# Microsoft 365: das Support-Postfach anbinden

Was in Entra ID und Exchange Online eingerichtet werden muss, damit
`src/server/tickets` ein freigegebenes Postfach lesen und daraus antworten
kann. Alles hier macht ein Administrator des Tenants **von Hand** — das Portal
fordert keine Rechte an und richtet nichts ein.

> **Es gibt für diese Installation noch keine Zugangsdaten.** Der Code ist
> gegen den dokumentierten Graph-Vertrag geschrieben und gegen aufgezeichnete
> Antworten getestet. Echte Zugangsdaten gehören ausschließlich in
> `.env.local` (gitignored) oder, besser, verschlüsselt in
> `/admin/settings/mail` — und an niemanden außer Microsoft.

---

## 1. Was am Ende dasteht

| Stück | Wofür |
|---|---|
| App-Registrierung in Entra ID | Die Identität, mit der das Portal sich bei Graph anmeldet |
| Anwendungsberechtigungen `Mail.ReadWrite` + `Mail.Send` | Lesen, verschieben, als gelesen markieren, antworten |
| **Application Access Policy** oder **RBAC-Verwaltungsbereich** | Begrenzt die App auf *dieses eine* Postfach |
| Freigegebenes Postfach, z. B. `support@example.net` | Woraus Tickets entstehen |
| Ordner `Processed` | Wohin eine verarbeitete Nachricht wandert (wird automatisch angelegt) |

Der dritte Punkt ist der wichtigste. `Mail.ReadWrite` als
**Anwendungsberechtigung** gilt ohne weiteres Zutun für *jedes Postfach im
Tenant*. Das ist nicht, was ein Ticketsystem braucht, und es ist nicht, was ein
Prüfer durchgehen lässt.

---

## 2. App-Registrierung

Portal: **Entra ID → App-Registrierungen → Neue Registrierung**.

- Name: `virtify.net Support`
- Unterstützte Kontotypen: **nur Konten in diesem Organisationsverzeichnis**
- Redirect-URI: **keine** (Client-Credentials-Flow, es gibt keinen Benutzer)

Notieren: **Verzeichnis-ID (Tenant)** und **Anwendungs-ID (Client)**.

Oder per PowerShell:

```powershell
Connect-MgGraph -Scopes "Application.ReadWrite.All","AppRoleAssignment.ReadWrite.All"

$app = New-MgApplication -DisplayName "virtify.net Support" -SignInAudience "AzureADMyOrg"
$sp  = New-MgServicePrincipal -AppId $app.AppId

"TenantId : $((Get-MgContext).TenantId)"
"ClientId : $($app.AppId)"
"ObjectId : $($sp.Id)"
```

### Berechtigungen vergeben und zustimmen

```powershell
# Die Graph-Anwendung selbst, und die Rollen-IDs, die auf jedem Tenant gleich sind.
$graph = Get-MgServicePrincipal -Filter "appId eq '00000003-0000-0000-c000-000000000000'"

$roles = @(
    "e2a3a72e-5f79-4c64-b1b1-878b674786c9",  # Mail.ReadWrite
    "b633e1c5-b582-4048-a93e-9f11b44c7e96"   # Mail.Send
)

foreach ($role in $roles) {
    New-MgServicePrincipalAppRoleAssignment `
        -ServicePrincipalId $sp.Id `
        -PrincipalId        $sp.Id `
        -ResourceId         $graph.Id `
        -AppRoleId          $role
}
```

Die Zustimmung des Administrators ist damit erteilt — eine
Anwendungsberechtigung hat keinen anderen Weg.

---

## 3. Anmeldung: Zertifikat oder Geheimnis

**Zertifikat ist der bessere Weg** und in Produktion der vorgesehene: ein
Geheimnis in einer Umgebungsvariablen ist ein Geheimnis in jedem Backup davon,
in jedem Prozess-Dump und in der Zwischenablage von jedem, der es einmal
eingefügt hat.

```powershell
# Selbstsigniert, drei Jahre, nicht exportierbarer privater Schlüssel.
$cert = New-SelfSignedCertificate `
    -Subject "CN=virtify.net Support" `
    -CertStoreLocation "Cert:\CurrentUser\My" `
    -KeyExportPolicy NonExportable `
    -KeySpec Signature `
    -NotAfter (Get-Date).AddYears(3)

Export-Certificate -Cert $cert -FilePath .\virtify-support.cer | Out-Null

$bytes = [System.IO.File]::ReadAllBytes((Resolve-Path .\virtify-support.cer))
Update-MgApplication -ApplicationId $app.Id -KeyCredentials @(@{
    Type  = "AsymmetricX509Cert"
    Usage = "Verify"
    Key   = $bytes
})

"Thumbprint: $($cert.Thumbprint)"
```

> **Stand der Umsetzung:** `src/server/tickets/channels/graph.ts` holt das
> Token heute mit `client_credentials` **und einem Clientgeheimnis**. Die
> Zertifikatsvariante (signiertes JWT als `client_assertion`) ist im
> Einstellungsschema bereits vorgesehen (`certificatePrivateKey`,
> `certificateThumbprint`) und noch nicht implementiert — siehe
> `docs/PROGRESS.md`, „bewusst weggelassen“. Bis dahin:

```powershell
# Clientgeheimnis, 12 Monate. Der Wert wird genau einmal angezeigt.
$secret = Add-MgApplicationPassword -ApplicationId $app.Id -PasswordCredential @{
    DisplayName = "virtify.net"
    EndDateTime = (Get-Date).AddMonths(12)
}

$secret.SecretText
```

Dieser Wert gehört in `/admin/settings/mail` (verschlüsselt mit
`APP_ENCRYPTION_KEY`, hard rule 6) — oder, für die Entwicklung, in
`.env.local`:

```
MSGRAPH_TENANT_ID=...
MSGRAPH_CLIENT_ID=...
MSGRAPH_CLIENT_SECRET=...
```

**Niemals ins Repository. `.env.local` ist gitignored; das ist der einzige Ort
im Arbeitsverzeichnis, an den ein echtes Geheimnis gehört.**

---

## 4. Das freigegebene Postfach

```powershell
Connect-ExchangeOnline

New-Mailbox -Shared -Name "Support" -DisplayName "virtify.net Support" `
    -PrimarySmtpAddress support@example.net

# Automatische Antworten des Postfachs selbst aus: das Portal schickt die
# Eingangsbestätigung, und zwei Autoresponder auf einem Postfach sind der
# Anfang einer Schleife.
Set-MailboxAutoReplyConfiguration -Identity support@example.net -AutoReplyState Disabled
```

---

## 5. Die App auf dieses Postfach begrenzen

Zwei Wege. **Einer von beiden ist Pflicht.**

### 5a. Application Access Policy (der etablierte Weg)

Begrenzt über eine Mail-aktivierte Sicherheitsgruppe.

```powershell
New-DistributionGroup -Name "virtify-app-mailboxes" `
    -Type Security `
    -PrimarySmtpAddress virtify-app-mailboxes@example.net

Add-DistributionGroupMember -Identity virtify-app-mailboxes@example.net `
    -Member support@example.net

# Die Gruppe darf sich selbst nicht als Empfänger anbieten.
Set-DistributionGroup -Identity virtify-app-mailboxes@example.net `
    -HiddenFromAddressListsEnabled $true

New-ApplicationAccessPolicy `
    -AppId <CLIENT-ID> `
    -PolicyScopeGroupId virtify-app-mailboxes@example.net `
    -AccessRight RestrictAccess `
    -Description "virtify.net darf nur das Support-Postfach sehen"
```

Prüfen — und zwar **beides**, sonst beweist der Test nichts:

```powershell
# Muss "Granted" sagen:
Test-ApplicationAccessPolicy -Identity support@example.net        -AppId <CLIENT-ID>

# Muss "Denied" sagen:
Test-ApplicationAccessPolicy -Identity irgendwer@example.net      -AppId <CLIENT-ID>
```

Die Richtlinie wirkt mit einiger Verzögerung (Microsoft nennt bis zu
30 Minuten). Ein `Denied`, das zu früh geprüft noch `Granted` sagt, ist kein
Grund, die Richtlinie für kaputt zu halten.

### 5b. RBAC für Anwendungen (der neuere Weg)

Feiner und ohne Verteilergruppe, dafür jünger:

```powershell
New-ManagementScope -Name "virtify-support-scope" `
    -RecipientRoot "example.net" `
    -RecipientRestrictionFilter "PrimarySmtpAddress -eq 'support@example.net'"

New-ServicePrincipal -AppId <CLIENT-ID> -ObjectId <SERVICE-PRINCIPAL-OBJECT-ID> `
    -DisplayName "virtify.net Support"

New-ManagementRoleAssignment -App <SERVICE-PRINCIPAL-OBJECT-ID> `
    -Role "Application Mail.ReadWrite" `
    -CustomResourceScope "virtify-support-scope"

New-ManagementRoleAssignment -App <SERVICE-PRINCIPAL-OBJECT-ID> `
    -Role "Application Mail.Send" `
    -CustomResourceScope "virtify-support-scope"
```

`Get-ManagementRoleAssignment -App <OBJECT-ID>` zeigt, was tatsächlich
zugewiesen ist.

---

## 6. Benachrichtigungen

Graph meldet neue Nachrichten an `https://<host>/api/webhooks/msgraph`.

- Die Adresse **muss** `https` sein und von außen erreichbar. Graph prüft sie
  beim Anlegen mit einem `POST` mit `?validationToken=…` und erwartet den
  Token innerhalb von zehn Sekunden als `text/plain` zurück.
- `clientState` ist ein 32-Byte-Geheimnis, das das Portal beim Anlegen
  erzeugt. Gespeichert wird nur sein Hash — genau wie bei einem API-Schlüssel,
  denn genau das ist es: **die einzige Autorisierung, die eine
  unauthentifizierte Webhook-Route hat.**
- Graph vergibt eine Postfach-Subscription für höchstens **4230 Minuten**
  (knapp drei Tage) und stellt danach wortlos ein. Ein stündlicher Auftrag
  (`tickets/subscriptions`) erneuert mit einem Tag Puffer.
- Darunter läuft alle fünf Minuten eine **Delta-Abfrage** (`tickets/sweep`).
  Sie ist der Grund, warum eine verlorene Benachrichtigung nur Verzögerung
  kostet und keine Nachricht.

Anlegen und Erneuern macht das Portal selbst — „Benachrichtigungen prüfen“ auf
`/admin/settings/mail` oder der stündliche Auftrag. Von Hand nachsehen:

```powershell
# In der Graph Explorer / mit einem App-Token:
# GET https://graph.microsoft.com/v1.0/subscriptions
```

---

## 7. Was danach noch zu tun ist

1. `/admin/settings/mail`: Tenant-ID, Client-ID und Geheimnis eintragen,
   Kanal aktivieren.
2. Auf derselben Seite eine **Abteilung** mit genau diesem Postfach anlegen.
   Ein Postfach gehört zu genau einer Abteilung — zwei würden die Frage „in
   welche Warteschlange gehört diese Nachricht“ zu einem Münzwurf machen.
3. „Benachrichtigungen prüfen“ drücken. Danach steht die Subscription mit
   ihrem Ablaufdatum auf der Seite.
4. Eine Testmail an das Postfach schicken und auf `/admin/tickets` nachsehen.
   Bis zu fünf Minuten, wenn die Benachrichtigung nicht durchkommt.
5. Optional: „Systemmails versenden über: Microsoft Graph“ und ein
   Absenderpostfach setzen. Damit gehen Rechnungen, Mahnungen und der
   SCA-Link über Graph statt über ein SMTP-Relay, das diese Installation nie
   hatte.

---

## 8. Was schiefgeht, und woran man es erkennt

| Symptom | Ursache |
|---|---|
| `ErrorAccessDenied` beim Lesen | Application Access Policy greift nicht, oder die Zustimmung fehlt |
| Subscription lässt sich nicht anlegen (`ValidationError`) | Die Adresse ist nicht von außen erreichbar oder nicht `https` |
| Benachrichtigungen hören nach drei Tagen auf | Der Erneuerungsauftrag läuft nicht — läuft der Worker? |
| Tickets entstehen doppelt | Sollte nicht passieren: `ticket_message.internet_message_id` ist eindeutig. Wenn doch, haben zwei Abteilungen dasselbe Postfach |
| Antworten kommen nicht an | `Mail.Send` fehlt, oder die Richtlinie deckt `Send` nicht ab |
| Eigene Antworten erzeugen neue Tickets | Das Postfach ist Mitglied eines Verteilers, der sich selbst zustellt. Die Message-ID-Erkennung fängt das ab; wenn nicht, steht das eigene Postfach nicht in `ticket_department.mailbox` |

### Eine Berechtigung wieder wegnehmen

```powershell
Remove-ApplicationAccessPolicy -Identity <POLICY-IDENTITY>
Remove-MgApplication -ApplicationId <OBJECT-ID>
```

Danach in `/admin/settings/mail` „Gespeicherte Zugangsdaten löschen“ — sonst
versucht der Auftrag weiter, sich mit etwas anzumelden, das es nicht mehr gibt.
