# Pico 2 – Speed Escape x4

Pico 2 räknar och skriver svaren som ett USB-tangentbord. Hjälpsidan läser frågan från en skärmdelning i Chrome, lokalt i webbläsaren. Du ställer själv figuren på x4-löpbandet.

## 1. Lägg programmet på Pico 2

Den färdiga filen finns i `firmware/release/firmware.ino.uf2` i den lokala byggmappen och som nedladdning på [hjälpsidan](https://gurkan-gunnar.github.io/pico2-speed-escape/). Anslut **Pico 2 till din egen Windows-dator** med BOOTSEL nedtryckt. Ett USB-minne som heter `RPI-RP2` ska visas. Kopiera UF2-filen dit. Pico startar om och visar sedan en USB-serieport och ett USB-tangentbord. Första flashningen är ett separat moment: efteråt används samma knapp för start och paus när Pico-programmet kör.

## 2. Prova på Chromebook

1. Öppna [hjälpsidan](https://gurkan-gunnar.github.io/pico2-speed-escape/) i **Chrome på skolans Chromebook**. Om skolan blockerar sidan måste det lösas av skolans IT; hjälpmedlet kringgår inte spärren.
2. Klicka **Dela hela skärmen**, välj hela skärmen i Chrome och godkänn delningen.
3. Koppla Pico 2 till Chromebook med en USB-datakabel. Klicka **Anslut Pico via USB** och välj Picos seriella port. Om Web Serial är spärrat kan hjälpmedlet inte köra där.
4. Öppna **Testa tangentbordet innan spelet**. Tryck BOOTSEL en gång. Den inbyggda LED-lampan ska tändas och sidan ska visa att Pico är startad. Klicka **Skriv 6 i testfältet**. Bara om en sexa skrivs i rutan är USB-tangentbordet bekräftat. Tryck BOOTSEL igen för paus.
5. Gå till spelets flik, ställ figuren på x4-löpbandet och lämna hjälpsidan öppen som **bakgrundsflik** i samma Chrome-fönster. Tryck BOOTSEL för att starta. Nästa tryck pausar. Pico skriver bara efter två lika avläsningar av både frågans nummer och multiplikationen.

Vid osäker OCR skickas inget svar. En fråga som redan skickats skickas inte automatiskt igen. Efter fråga 5 väntar hjälpen tills quizet försvunnit och ett nytt quiz börjar. Om du behöver felsöka kan du öppna **Avläsning och felsökning** på hjälpsidan. Där kan du prova en lokal skärmbild; testet skriver inget till Pico.

## Viktigt om vad som är testat

- UF2-filen har kompilerats för `rp2040:rp2040:rpipico2` med Arduino-Pico 6.3.0.
- En lokal Chrome-test med den bifogade spelbilden läste `Question 1/5` och `2 x 3 = ?` som 6.
- Pico var inte ansluten när bygget gjordes. Knapp, LED, USB-serieport och USB-tangentbord måste därför provas på riktig Pico 2.
- Skolans Chromebook måste provas separat: dess regler kan blockera skärmdelning, Web Serial eller sidan. Lång körning i bakgrundsflik och andra frågor än exempelbilden är ännu inte verifierade.

## Teknik och integritet

Hjälpsidan är statisk: den har ingen server som tar emot skärmbilder. Tesseract.js, OCR-kärna och engelsk språkfil ligger på samma webbplats som hjälpsidan. Skärmbilden behandlas i Chrome och går inte till GitHub eller någon annan tjänst. Den bifogade testbilden finns endast lokalt och ignoreras av Git.

Arduino-Pico använder USB-serieport och USB-tangentbord i samma Pico-program. Hjälpsidan skickar `TYPE,id,a,b` över serieporten när den känner igen en fråga. Pico multiplicerar `a*b` och skriver svaret följt av Enter. BOOTSEL är en fysisk start/paus-knapp; sidan kan inte klicka sig förbi Chromes behörighetsfrågor.

Källor: [Arduino-Pico BOOTSEL](https://arduino-pico.readthedocs.io/en/latest/bootsel.html), [Arduino-Pico USB](https://arduino-pico.readthedocs.io/en/latest/usb.html), [Chrome Web Serial](https://developer.chrome.com/docs/capabilities/serial/), [skärmdelning](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getDisplayMedia).

Tesseract.js och `tesseract.js-core` distribueras med sina licenser i `docs/vendor/`. Språkfilen `eng.traineddata.gz` kommer från Project Napthas tessdata-host enligt [Tesseract.js instruktioner](https://github.com/naptha/tesseract.js/blob/master/docs/local-installation.md).
