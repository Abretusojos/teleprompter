# Teleprompter — voice tracking

Teleprompter PWA, który przewija tekst wtedy, gdy **naprawdę** wypowiadasz słowa ze skryptu. Bez konta, bez reklam, bez abonamentu.

## Jak działa śledzenie mowy

1. `webkitSpeechRecognition` (Web Speech API) zamienia mowę na tekst.
2. Ostatnie ~10 rozpoznanych słów jest dopasowywanych do okna ±80 słów w skrypcie algorytmem odległości Levenshteina na poziomie słów.
3. Gdy dopasowanie przekroczy próg pewności, prompter przeskakuje do trafionego słowa i przewija je do linii czytania (34% wysokości ekranu).

Dzięki temu przejęzyczenia, pominięte zdania i powtórki nie rozwalają czytania — nie ma tu timera udającego śledzenie. Osobny tryb „Ręczny” to zwykłe przewijanie ze stałą prędkością i jest tak oznaczony.

## Funkcje

- duży, regulowany tekst (24–96 px), tryb skupienia / pełny ekran, blokada usypiania ekranu
- Start / Pauza / Stop, tap na dowolne słowo = skok, „Przeskocz…” po numerze słowa lub frazie
- edytor z wklejaniem tekstu (zapisywany lokalnie), wskazówki w `[nawiasach]` ignorowane przy dopasowaniu
- języki rozpoznawania: English (US/UK), Polski
- PWA: manifest, ikona, offline shell (service worker), bez żadnych zewnętrznych skryptów

## Ograniczenia iOS (ważne)

iOS **nie udostępnia** Web Speech API w aplikacjach dodanych do ekranu początkowego (tryb standalone, WebKit bug 225298). Dlatego manifest ma `display: "browser"` — ikona z ekranu głównego otwiera stronę w Safari, gdzie mikrofon działa. W trybie standalone aplikacja pokazuje ostrzeżenie i działa tylko ręcznie.

Wymagane: włączone Dyktowanie (Ustawienia → Ogólne → Klawiatura → Dyktowanie) i zgoda na mikrofon dla strony.

## Alternatywa natywna

[Open Prompter](https://apps.apple.com/pl/app/open-prompter/id6763611915) — darmowa, MIT, natywna apka iOS z rozpoznawaniem mowy na urządzeniu (SFSpeechRecognizer). Działa w trybie offline i nie zależy od Web Speech API.

## Uruchomienie lokalne

```sh
python3 -m http.server 8791
# http://localhost:8791
```

Mikrofon działa tylko po HTTPS (GitHub Pages zapewnia TLS).

## Podziękowania

Pomysł na dopasowanie transkryptu do skryptu oparty na `jlecomte/voice-activated-teleprompter` (MIT).

MIT License.
