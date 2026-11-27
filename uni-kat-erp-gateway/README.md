# UNI KAT ERP gateway

Posrednik između UNI KAT-a (preglednik) i Business Centrala. Prema pregledniku govori **TMConnect ERP V2.14** (`GetErpInformation`), isti standard kao TKAT. Prema BC-u zove **BC TKAT API**: OData akcije `TKATApiMgmt_GetItemsPrice`, `TKATApiMgmt_GetItemsStock`, `TKATApiMgmt_GetItemsRestricition` i `TKATApiMgmt_GetItemsPartnerStock` s `customerNo`, servisnim korisnikom i Basic autentikacijom.

```
UNI KAT (preglednik)                 gateway (Tokić server)                          BC
  GetErpInformationRequest   ──►   prijavljeni kupac (K-šifra)          ──►   TKATApiMgmt_GetItemsPrice
  (bez lozinki)                    servisni korisnik iz tajni           ──►   TKATApiMgmt_GetItemsStock
  GetErpInformationReply     ◄──   složen iz BC odgovora                ◄──
```

Ako se kasnije spoji izravno na TMConnect SOAP servis, postavi `TMC_MODE=soap`.

- Preglednik slaže `GetErpInformationRequest` jednako kao TKAT (`ArticleTmf` s `ArticleIdErp` = Tokić šifra, `ErpInformation` po artiklu, `ContextId` 1, `TypeId` 1).
- Preglednik nikad ne vidi servisnu lozinku za BC. Gateway iz svoje sesije zna koji je kupac prijavljen i samo za njega pita BC (`customerNo`).
- Izložena je samo metoda `GetErpInformation`. `SendOrder` namjerno nije, jer "U košaricu" predaje artikl TKAT-u.

## Pokretanje

Potreban je Node.js 18 ili noviji, bez dodatnih paketa.

```bash
BC_BASE_URL=https://<bc-server>:<port>/<instanca> \
BC_COMPANY="<naziv tvrtke u BC-u>" \
BC_USER=<iz tajni> BC_PASSWORD=<iz tajni> \
ALLOWED_ORIGIN=https://josip-kelava.github.io \
node server.js
```

Lozinka servisnog korisnika se ne upisuje u repozitorij ni u skripte. Treba je čitati iz spremišta tajni (npr. Azure Key Vault) ili iz varijable okoline na serveru.

| Varijabla | Značenje |
|---|---|
| `BC_BASE_URL`, `BC_COMPANY` | BC web servis (`https://<bc-server>:<port>/<instanca>`) i naziv tvrtke u BC-u. Stvarne vrijednosti za test i produkciju su u internoj dokumentaciji, ne u ovom repozitoriju. |
| `BC_USER`, `BC_PASSWORD` | servisni korisnik BC-a, isključivo iz spremišta tajni |
| `ALLOW_DEV_LOGIN=1` | samo za interno testiranje: prijava samo K-šifrom |
| `TMC_MODE` | `bcapi` (zadano), `soap` ili `xml` |
| `BC_TMCONNECT_URL` | samo za `soap`/`xml` način |
| `TMC_SOAP_NS`, `TMC_SOAP_ACTION`, `TMC_SOAP_PARAM` | iz `TMConnect_V2.14.wsdl` |
| `BC_AUTH_HEADER` | ako BC servis traži i servisnu autentikaciju (npr. Basic) |
| `ALLOWED_ORIGIN` | jedina stranica koja smije zvati gateway |

## Rute

- `POST /login` – `{"customerId":"K…"}`. Postavlja HttpOnly kolačić sesije. Za sada radi samo uz `ALLOW_DEV_LOGIN=1`, dok se ne dogovori prava prijava (vidi Otvoreno).
- `POST /logout` – briše sesiju.
- `POST /tmconnect/GetErpInformation` – tijelo je `GetErpInformationRequest` (XML), odgovor je `GetErpInformationReply` (XML).
- `GET /health`

## Spajanje prototipa

Prototip bez adrese gatewaya radi u **DEMO** načinu: odgovor je simuliran u TMConnect formatu iz podataka prototipa. S adresom gatewaya ide na BC:

```
https://josip-kelava.github.io/Claude_code_tokic-dd/tkat/prototip.html?erp=https://<gateway-adresa>
```

## Mapiranje BC → TMConnect

| BC TKAT API | TMConnect `GetErpInformationReply` |
|---|---|
| `GetItemsPrice`: `price` (MPC, `priceInclVat`, `vat`) | `Price` tip 5 "MPC" |
| `price × (1 − discountPct/100)` | `Price` tip 4 "MPC s popustom", `RebateProcent` = `discountPct` |
| `price = 0` (cijena ograničena) | bez cijene (u UNI KAT-u "Na upit") |
| `itemOnAction`, `actionToDate` | `Memo` "Akcija do …" |
| `GetItemsStock`: `storeCode`, `locationCode`, `address`, `availableInventory` | `Warehouse`: `Id` = `locationCode`, `Name` = "P038 na skl. \*C038\* - adresa" (kao u TKAT-u), količina = `availableInventory` (najviše 10) |
| `GetItemsRestricition`: `isRestricted` | `AvailabilityState` "Nije moguće naručiti" |
| `GetItemsPartnerStock`: `partnerCode`, `locationCode`, `inventory` | dodatni `Warehouse` "BARTOG – skladište 30", stanje "BARTOG" (kao u TKAT-u) |

Testirano na lažnom BC servisu s oblikom stvarnih odgovora. Primjer: 0067, `price` 11,80, `discountPct` 40 → vaša cijena 7,08 € s PDV-om, MPC 11,80 €.

## Otvoreno

- **Matična poslovnica kupca** (`IsDefault`). `GetItemsStock` je ne vraća. Vjerojatno je u `TKATApiMgmt_CustomerInfo`, pa treba primjer tog odgovora.
- **Prijava kupca.** BC TKAT API ne provjerava lozinku kupca (zove se servisnim korisnikom + `customerNo`). UNI KAT mora sam potvrditi tko je kupac:
  - kad se otvara iz TKAT-a: predaja prijavljenog korisnika (token ili potpisani parametar), u dogovoru s Topmotiveom;
  - kad se otvara samostalno: isti TKAT račun preko Topmotivea ili Tokić identitet (npr. Entra ID).

  Do tada je moguća samo interna prijava (`ALLOW_DEV_LOGIN=1`).
- **HTTPS prema BC-u.** Servisna lozinka ne smije ići nešifrirano, pa treba HTTPS ili barem zatvorena interna mreža.
- **Predaja artikla TKAT košarici** – kasnije.
