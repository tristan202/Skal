# Skal

En lille SSH-klient med faner, redigerbar serverliste, filoverførsel og serverstatus – inspireret af Termius. Bygget med Electron, xterm.js og ssh2, så den ikke afhænger af PuTTY.

## Kom i gang

Kræver Node.js 18 eller nyere.

```
npm install
npm start
```

Byg et program, der kan installeres:

```
npm run dist:win        # Windows-installer (anbefalet – starter hurtigt)
npm run dist:zip        # Windows: zip, der kan pakkes ud og køres direkte
npm run dist:portable   # Windows: én portabel .exe (starter langsomt)
npm run dist            # nuværende platform
```

## Funktioner

- Serverliste med grupper, søgning og farver. Opret, redigér, duplikér og slet servere fra panelet til højre eller ved at højreklikke. Dobbeltklik for at forbinde.
- Flere sessioner i faner, også flere til samme server (Ctrl+Shift+D). Skriver du `exit`, lukker fanen; falder forbindelsen ud, kan du trykke Enter for at genforbinde.
- Login med adgangskode, privat nøgle eller SSH-agent / Pageant. Nøgler kan være OpenSSH, PEM, PKCS#8 eller PuTTY .ppk (v2 og v3). Mangler en passphrase, bliver du spurgt.
- Adgangskoder krypteres med styresystemets nøglering (DPAPI på Windows).
- Host key-tjek med "trust on first use" og tydelig advarsel, hvis en servers nøgle ændrer sig.
- Hurtig forbindelse: skriv `bruger@host` eller `bruger@host:2222` i søgefeltet og tryk Enter.
- PuTTY-vaner: markér tekst for at kopiere, højreklik for at indsætte.

### Filer (dual-pane, som Total Commander / mc)

Skift mellem **Terminal** og **Filer** øverst til højre i en session, eller tryk Ctrl+Shift+F. Venstre side er denne computer, højre side er serveren. Filhåndteringen bruger sessionens forbindelse, så der skal ikke logges ind igen.

| Tast | Handling |
|---|---|
| Tab | Skift side |
| Pil op/ned, PgUp/PgDn, Home/End | Flyt markøren |
| Enter / dobbeltklik | Åbn mappe eller fil |
| Backspace | Op ad en mappe |
| Mellemrum / Insert | Markér og gå videre (Shift+pil markerer også) |
| Ctrl+A / Escape | Markér alt / fjern markering |
| Skriv bogstaver | Hop til fil, der starter sådan |
| F2 (eller Shift+F6) | Omdøb |
| F4 | Åbn. En serverfil åbnes i dit standardprogram og uploades automatisk, hver gang du gemmer |
| F5 | Kopiér markerede til den anden side |
| F6 | Flyt markerede til den anden side |
| F7 | Ny mappe |
| F8 / Delete | Slet (lokalt: til papirkurven) |
| Ctrl+R / Ctrl+H | Opdatér / vis skjulte filer |

Træk markerede filer fra den ene side til den anden for at kopiere (hold Shift for at flytte), slip dem på en mappe for at lægge dem i den, eller træk filer ind fra Stifinder til serversiden. Findes et element allerede, kan du vælge Overskriv, Spring over eller Annullér. Overførsler vises med fremskridt og hastighed og kan annulleres. Klik på kolonneoverskrifterne for at sortere. Begge sider husker sidste mappe (serversiden pr. server).

### Online-prik

Hvert kort på Hosts-siden har en prik ved navnet: grøn, når serverens SSH-port svarer, rød når den er nede eller ikke svarer, og grå mens der tjekkes. Hold musen over prikken for svartid eller fejl. Der logges ikke ind – Skal læser blot serverens SSH-hilsen – så det virker også for servere uden gemt adgangskode. Tjekket sker højst hvert 3. minut og kun mens siden er åben; har du en session åben, eller viser serverstatus allerede at serveren kører, laves intet ekstra tjek. På serveren ses det som en kort linje "Connection closed … [preauth]" i loggen.

### Serverstatus

Hosts-siden viser CPU, RAM, disk, load, oppetid og styresystem for Linux-servere og opdateres hvert 10. sekund, mens siden er åben. Hold musen over en måler for detaljer (alle diske, swap, load-gennemsnit).

Har du en session åben til serveren, bruges den. Ellers holder Skal en stille baggrundsforbindelse åben, så længe siden vises; den lukkes efter 3 minutter uden brug. Baggrundsforbindelser spørger aldrig om noget, så serveren skal have gemt login (adgangskode, nøgle eller agent), og dens host-nøgle skal være godkendt ved en tidligere forbindelse. Kan slås fra med **Serverstatus** øverst på siden.

## Sprog

Skal findes på dansk, engelsk, tysk, fransk, italiensk, spansk og svensk. Første gang bruges Windows' sprog (engelsk, hvis det ikke er et af de syv). Skift nederst i sidebjælken – det slår igennem med det samme, også i åbne sessioner og i dialoger og fejlbeskeder.

Alle tekster ligger i `renderer/strings.js` med de syv sprog ved siden af hinanden. Et nyt sprog tilføjes ved at give hver tekst en oversættelse og tilføje sproget i `LANGS` og `LOCALES` øverst i filen.

## Genveje

| Genvej | Handling |
|---|---|
| Ctrl+Shift+H | Vis hosts / søgefelt |
| Ctrl+Shift+N | Ny host |
| Ctrl+Tab / Ctrl+Shift+Tab | Næste / forrige fane |
| Ctrl+Shift+W | Luk fane |
| Ctrl+Shift+D | Duplikér session |
| Ctrl+Shift+F | Skift mellem terminal og filer |
| Ctrl+Shift+C / V | Kopiér / indsæt |
| Midterklik på fane | Luk fane |

## Hvor ligger data

`hosts.json` og `known_hosts.json` ligger i `%APPDATA%\Skal` (Windows), `~/Library/Application Support/skal` (macOS) eller `~/.config/skal` (Linux). Den installerede version ligger i `%LOCALAPPDATA%\Programs\skal`.

## Opbygning

- `main.js`: lager, kryptering, SSH-forbindelser og host key-tjek
- `sftp.js`: filoverførsel og redigering af serverfiler
- `local.js`: den lokale side af filhåndteringen
- `metrics.js`: serverstatus
- `ping.js`: online-prikken
- `keyconvert.js`: læsning af PuTTY- og andre nøgleformater
- `preload.js`: den sikre bro til brugerfladen
- `renderer/`: brugerfladen (`renderer.js`, `commander.js`, `strings.js` med alle tekster, HTML og CSS)
