# GEM Explorer AI: knowledge dataset, revision 2 (for your review)

Status: **draft for review. Nothing has been loaded into Supabase.**  
Built from the official Grand Egyptian Museum websites (gem.eg, gem.eg/ar and tickets.gem.eg).

**Size:** 52 source pages (25 official Arabic pages) · 22 entities (6 areas, 16 artefacts) · 72 notes (34 English, 38 Arabic).

## What changed in this revision

- **Arabic names are now the museum's own.** Taken from the official gem.eg/ar pages, e.g. البهو العظيم (Grand Hall), الدرج العظيم (Grand Stairs), المسلة المعلقة (Hanging Obelisk). The earlier unofficial «القاعة الكبرى» is gone. Gods are written المعبود / المعبودة, as on the site.
- **Arabic notes expanded: 38 (was 8).** Every area and artefact now has an Arabic name, an Arabic summary and at least one Arabic note.
- **Arabic basis is stated per note** (see the 'Arabic basis' line under each Arabic note): 30 Arabic notes are written from an official Arabic page, and the other 8 are translations of the cited English page. A note cites an Arabic page only if every fact in it was seen on that page.
- **Every `source_keys` value points at a real source.** Checked three times: when the files are validated, again against the database before any entity is written, and by a read-only query after the migration.
- **Estimated visit minutes are labelled `team_estimate`** in the data and in the database column comments. No note states minutes, and a check refuses any that does.
- One English note and its summary were corrected (the mirror of Mesehti: the official page does have a description).
- **Two content decisions applied (26 Nov):** see 'Findings' below.

## How to review this

1. **Every note is written in our own words** from the cited page. Please check that each note says only what its source says.
2. **The Arabic notes are still team-written and need a check by a native Arabic reader.** Names and terms follow the official site; the sentences around them are ours.
3. **Minutes are team estimates, not museum timings.** The only official duration we use is the guided tour (about two hours), which sits in a note and not in the minutes column.
4. Tell me which notes to change, remove or add.

## Findings you should know about

- **Opening hours:** the Arabic FAQ page lists different hours (10:00 to 17:00) from tickets.gem.eg. The dataset follows tickets.gem.eg, which the Arabic opening-hours page also matches. The notes are marked time-sensitive.
- **1992 land (decided 26 Nov):** the English page says 117 acres and the Arabic page says 117 feddans. Both notes now say only that land near the Giza pyramids was allocated in 1992, with no figure or unit. The complex size is given as about 500,000 square metres, from the official museum map pages.
- **Hanging Obelisk (decided 26 Nov):** the main notes and the entity summary are neutral (no 'first' or 'only'). The museum's own wording is kept in two separate notes, one per official page, each saying it is the museum's description and not independently verified. The English page says 'only' hanging obelisk, the Arabic page says 'first'; the two pages disagree and we do not choose between them.
- **Spelling:** the official Arabic 'حجرى' is written 'حجري' in our notes. 'قاعات العرض الرئيسة' (official) and 'القاعات الرئيسية' (common) are different words to the search, so the main-galleries note contains both.
- **Arabic-only highlight notes** (Grand Hall highlights, Grand Stairs highlights, Main Galleries themes) have no English twin yet.
- **Wikipedia conflict:** Wikipedia describes the Tutankhamun galleries differently from the official site; the dataset uses the official site only.

## Areas (what the Visit Planner can use)

| Order | Area | Official Arabic name | Est. minutes (team estimate) | Tags | Status |
|---|---|---|---|---|---|
| 1 | Hanging Obelisk | المسلة المعلقة | 10 | kings, obelisks, architecture, ramesses, photography | verified |
| 2 | Grand Hall | البهو العظيم | 15 | kings, statues, architecture, ramesses, photography | verified |
| 3 | Grand Stairs | الدرج العظيم | 30 | kings, gods, statues, history, architecture | verified |
| 4 | Main Galleries | قاعات العرض الرئيسة | 75 | history, daily-life, kings, gods, funerary | verified |
| 5 | Tutankhamun Galleries | قاعات عرض كنوز توت عنخ آمون | 60 | tutankhamun, kings, gold, funerary, treasures | verified |
| – | Khufu's Boats Museum | متحف مراكب الملك خوفو | none (not plannable) | boats, pyramids, history | single_source |

## Artefacts

| Artefact | Area | Period | Arabic name |
|---|---|---|---|
| Colossal Statue of Ramesses II | grand-hall | New Kingdom, Dynasty 19 | تمثال حجري ضخم للملك رمسيس الثاني |
| Obelisk of King Ramesses II | hanging-obelisk | New Kingdom, Dynasty 19 | مسلة الملك رمسيس الثاني |
| Seated Statue of Goddess Sekhmet | grand-stairs | New Kingdom, Dynasty 18 | تمثال للمعبودة سخمت على هيئة اللبؤة |
| Doorway of King Amenemhat I | grand-stairs | Middle Kingdom, Dynasty 12 | بوابة للملك أمنمحات الأول |
| Standing Statue of King Thutmose III | grand-stairs | New Kingdom, Dynasty 18 | تمثال للملك تحتمس الثالث |
| King Ramesses II and a Goddess | grand-stairs | New Kingdom, Dynasty 19 | تمثال للملك رمسيس الثاني وإحدى المعبودات |
| Sarcophagus of Djehutymose | grand-stairs | New Kingdom, Dynasty 19 | تابوت جحوتي مس |
| The Golden Burial Mask of Tutankhamun | tutankhamun-galleries | New Kingdom, Dynasty 18 | قناع الدفن الذهبي للملك توت عنخ آمون |
| Royal Diadem | tutankhamun-galleries | New Kingdom, Dynasty 18 | الإكليل الملكي |
| Outer Coffin | tutankhamun-galleries | New Kingdom, Dynasty 18 | التابوت الخارجي |
| Golden Throne | tutankhamun-galleries | New Kingdom, Dynasty 18 | كرسي العرش الذهبي |
| Canopic Chest | tutankhamun-galleries | New Kingdom, Dynasty 18 | صندوق الأواني الكانوبية |
| Guardian Statues of Tutankhamun | tutankhamun-galleries | New Kingdom, Dynasty 18 | تمثال الـكا |
| Anubis on a Chest | tutankhamun-galleries | New Kingdom, Dynasty 18 | أنوبيس رابض فوق صندوق طقسي |
| Model of Tutankhamun on a Funerary Bed | tutankhamun-galleries | New Kingdom | تمثال للملك راقداً على النعش |
| Mirror of Mesehti | main-galleries | Middle Kingdom, Dynasty 11 | مرآة برونزية لمسحتي |

## All notes

### `gem-overview-en`  ·  EN  ·  verified
Entity: (general)  ·  Source: [Museum Story](https://gem.eg/en/about/museum-story/)

> The Grand Egyptian Museum (GEM) describes itself as the largest museum in the world dedicated to ancient Egyptian civilisation, from prehistory to the end of the Greek and Roman periods. It opened its doors on 1 November 2025.

### `gem-overview-ar`  ·  AR  ·  verified
Entity: (general)  ·  Source: [Museum Story](https://gem.eg/en/about/museum-story/)  ·  Arabic basis: translated from the English page

> يصف المتحف المصري الكبير نفسه بأنه أكبر متحف في العالم مخصص للحضارة المصرية القديمة، من عصور ما قبل التاريخ حتى نهاية العصرين اليوناني والروماني. وقد فتح أبوابه للجمهور في الأول من نوفمبر 2025.

### `gem-history-timeline-en`  ·  EN  ·  verified
Entity: (general)  ·  Source: [Museum Story](https://gem.eg/en/about/museum-story/)

> Museum timeline from GEM's own story: land near the Giza pyramids was allocated for the project in 1992; the foundation stone was laid in 2002; the Irish firm Heneghan Peng won the design competition in 2003; construction took shape between 2005 and 2008; in 2018 the statue of Ramesses II became the first artefact placed in the Grand Hall; the Grand Stairs partly opened to visitors in 2023.

### `gem-complex-size-en`  ·  EN  ·  verified
Entity: (general)  ·  Source: [GEM Complex Map](https://gem.eg/visit/plan-your-visit/museum-maps/)

> The GEM complex covers about 500,000 square metres. The main building has a museum section of 92,000 square metres and a commercial section of 40,000 square metres, and both are entered through the Grand Hall.

### `gem-ticket-includes-en` ⏱  ·  EN  ·  verified
Entity: (general)  ·  Source: [Official Ticketing Website](https://tickets.gem.eg/)

> According to the official ticketing site, a visit includes the Tutankhamun Galleries, the Main Galleries, the Grand Hall, the Grand Stairs, Khufu's Boats Museum, the commercial area and the outdoor gardens. Always confirm on the official site.

### `gem-official-tickets-en` ⏱  ·  EN  ·  verified
Entity: (general)  ·  Source: [Official Ticketing Website](https://tickets.gem.eg/)

> tickets.gem.eg is the only official website for buying Grand Egyptian Museum tickets, and the museum is not responsible for tickets bought on other platforms. The booking made in GEM Explorer is a student demo and is not a museum ticket.

### `gem-hours-en` ⏱  ·  EN  ·  verified
Entity: (general)  ·  Source: [Official Ticketing Website](https://tickets.gem.eg/)

> Official opening hours listed on the ticketing site: Sunday, Monday, Tuesday, Thursday and Friday, the GEM complex is open 8:30 AM to 7:00 PM and the galleries 9:00 AM to 6:00 PM. On Saturday and Wednesday the complex is open 8:30 AM to 10:00 PM and the galleries 9:00 AM to 9:00 PM. The last entry is one hour before the galleries close. Hours can change, so check the official site before travelling.

### `gem-hours-ar` ⏱  ·  AR  ·  verified
Entity: (general)  ·  Source: [Official Ticketing Website](https://tickets.gem.eg/)  ·  Arabic basis: translated from the English page

> مواعيد العمل المعلنة على موقع التذاكر الرسمي: أيام الأحد والاثنين والثلاثاء والخميس والجمعة يفتح مجمع المتحف من 8:30 صباحاً حتى 7:00 مساءً وتفتح القاعات من 9:00 صباحاً حتى 6:00 مساءً. يومي السبت والأربعاء يفتح المجمع من 8:30 صباحاً حتى 10:00 مساءً والقاعات من 9:00 صباحاً حتى 9:00 مساءً. آخر دخول قبل إغلاق القاعات بساعة. قد تتغير المواعيد، لذلك تأكد من الموقع الرسمي قبل الزيارة.

### `gem-guided-tour-en` ⏱  ·  EN  ·  verified
Entity: (general)  ·  Source: [FAQs](https://gem.eg/faqs/)

> The standard guided tour lasts approximately 2 hours and covers the Tutankhamun Galleries, the Grand Hall, the Grand Stairs and the Main Galleries.

### `gem-tour-sequence-en` ⏱  ·  EN  ·  verified
Entity: (general)  ·  Source: [Group Guided Tour](https://gem.eg/en/visit/plan-your-visit/tours/group-guided-tour/)

> The museum's group tour description follows this sequence: the Hanging Obelisk, the Grand Hall, the Grand Stairs, the Main Galleries, and finally the Tutankhamun Galleries. This is the order of the tour description, not a statement about walking distances.

### `gem-private-tour-en` ⏱  ·  EN  ·  verified
Entity: (general)  ·  Source: [Private Tour](https://gem.eg/en/visit/plan-your-visit/tours/private-tour/)

> Private tours of the Main Galleries can be arranged for a person or a group and tailored to their language, interests and pace.

### `gem-collection-range-en`  ·  EN  ·  verified
Entity: (general)  ·  Source: [Collection: Treasures of GEM](https://gem.eg/collection/)

> GEM's collections range from the Prehistoric period to the Roman period, and the museum's collection pages present each artefact with its period, dynasty, material and where it was found.

### `hanging-obelisk-en`  ·  EN  ·  verified
Entity: hanging-obelisk  ·  Source: [Artefact: Obelisk of King Ramesses II](https://gem.eg/en/collection/artefacts/obelisk-of-king-ramesses-ii)

> The Hanging Obelisk of Ramesses II stands in a 30,000 square metre square. It is lifted on a platform held up by four massive pillars so visitors can see the royal cartouches carved on its base.

### `hanging-obelisk-wording-en`  ·  EN  ·  verified
Entity: hanging-obelisk  ·  Source: [Artefact: Obelisk of King Ramesses II](https://gem.eg/en/collection/artefacts/obelisk-of-king-ramesses-ii)

> The museum's own English artefact page calls the Hanging Obelisk the world's only hanging obelisk and the first artefact to welcome visitors. This is the museum's description of itself; we have not verified it independently, so present it as the museum's wording.

### `obelisk-ramesses-ii-en`  ·  EN  ·  verified
Entity: obelisk-ramesses-ii  ·  Source: [Artefact: Obelisk of King Ramesses II](https://gem.eg/en/collection/artefacts/obelisk-of-king-ramesses-ii)

> Ramesses II raised more than ten obelisks at Tanis in the Eastern Delta. This granite obelisk, 16 metres tall and weighing 87 tons, was the highest ever to stand at Tanis. Its four sides carry the king's Horus name, throne name and birth name.

### `grand-hall-en`  ·  EN  ·  verified
Entity: grand-hall  ·  Source: [GEM Complex Map](https://gem.eg/visit/plan-your-visit/museum-maps/)

> The Grand Hall is the entrance to both the museum section and the commercial section of the main building. Visitors are welcomed there by the towering statue of Ramesses II.

### `colossal-statue-ramesses-ii-en`  ·  EN  ·  verified
Entity: colossal-statue-ramesses-ii  ·  Source: [Artefact: Colossal Statue of Ramesses II](https://gem.eg/en/collection/artefacts/colossal-statue-of-ramesses-ii)

> The colossal granite statue of Ramesses II is about 11.35 metres high and comes from Memphis (Mit Rahina), New Kingdom, Dynasty 19. It originally stood outside the main temple of the god Ptah, guarding its sacred inner space, and was long thought of as a god who listened to worshippers. His children Prince Khaemwaset and Princess Bintanath are carved behind his legs.

### `colossal-statue-arrival-en`  ·  EN  ·  verified
Entity: colossal-statue-ramesses-ii  ·  Source: [Museum Story](https://gem.eg/en/about/museum-story/)

> The statue of Ramesses II was the first artefact to find its home in the Grand Hall, arriving in 2018.

### `grand-stairs-en`  ·  EN  ·  verified
Entity: grand-stairs  ·  Source: [Group Guided Tour](https://gem.eg/en/visit/plan-your-visit/tours/group-guided-tour/)

> The Grand Stairs are described by the museum as home to 59 artefacts. Highlights listed on the collection page include the statue of the god Ptah with Ramesses II and the goddess Sekhmet, a seated statue of Sekhmet, a Hathor capital and the pyramidion of an obelisk of Queen Hatshepsut. The Grand Stairs partly opened to visitors in 2023.

### `seated-statue-sekhmet-en`  ·  EN  ·  verified
Entity: seated-statue-sekhmet  ·  Source: [Artefact: Seated Statue of Goddess Sekhmet](https://gem.eg/en/collection/artefacts/seated-statue-of-goddess-sekhmet)

> This granite statue shows the goddess Sekhmet seated; her name means 'she who is powerful'. She was linked with fire and destruction and also with protecting the king. Amenhotep III set up many statues of her in his temple on the west bank at Thebes, and some were moved about 300 years later to the temple of the goddess Mut at Karnak.

### `doorway-amenemhat-i-en`  ·  EN  ·  verified
Entity: doorway-amenemhat-i  ·  Source: [Artefact: Doorway of King Amenemhat I](https://gem.eg/en/collection/artefacts/doorway-of-king-amenemhat-i)

> The granite blocks of this doorway, a lintel and two jambs, were found in 1883 at Ezbet Helmi in the Eastern Delta (Middle Kingdom, Dynasty 12). One face has text saying Amenemhat I built a monument, and the other says Senwosret III, who ruled almost a hundred years later, renewed it.

### `standing-statue-thutmose-iii-en`  ·  EN  ·  verified
Entity: standing-statue-thutmose-iii  ·  Source: [Artefact: Standing Statue of King Thutmose III](https://gem.eg/en/collection/artefacts/standing-statue-of-king-thutmose-iii)

> This granite statue of Thutmose III was found in 1860 at the Great Temple of Amun at Karnak. The king wears the nemes headcloth, a false beard and a kilt with a projecting front. The cartouche on the belt names Thutmose III, but traces of another name can still be seen underneath.

### `ramesses-ii-and-a-goddess-en`  ·  EN  ·  verified
Entity: ramesses-ii-and-a-goddess  ·  Source: [Artefact: King Ramesses II and a Goddess](https://gem.eg/en/collection/artefacts/king-ramesses-ii-and-a-goddess)

> Fragments of this red granite statue were found in 1825 in the Great Temple of Amun at Tanis. It shows Ramesses II with a goddess, probably Anath, a foreign war goddess who protected the king. She touches the king's crown with one hand and rests the other on his arm.

### `sarcophagus-djehutymose-en`  ·  EN  ·  verified
Entity: sarcophagus-djehutymose  ·  Source: [Artefact: Sarcophagus of Djehutymose](https://gem.eg/en/collection/artefacts/sarcophagus-of-djehutymose)

> This granite sarcophagus was found in 1915 in a burial shaft at Tuna el-Gebel. It belonged to Djehutymose, a high official of Amun-Re and overseer of works in the House of Thoth, who lived in Dynasty 19.

### `main-galleries-en`  ·  EN  ·  verified
Entity: main-galleries  ·  Source: [Group Guided Tour](https://gem.eg/en/visit/plan-your-visit/tours/group-guided-tour/)

> The Main Galleries consist of twelve curated halls that tell the story of ancient Egyptian civilisation from prehistoric times to the Graeco-Roman era. Individual halls are not named or numbered in the official pages reviewed for this knowledge base, so this assistant does not describe hall numbers or hall layouts.

### `mirror-of-mesehti-en`  ·  EN  ·  verified
Entity: mirror-of-mesehti  ·  Source: [Artefact: Mirror of Mesehti](https://gem.eg/en/collection/artefacts/mirror-of-mesehti)

> The collection page lists the Mirror of Mesehti under the Main Galleries (Middle Kingdom, Dynasty 11). It is a bronze mirror from the burial goods of Mesehti, governor of the Asyut province, made of a bronze disc and a wooden handle with a wedjat eye on each side. Mirrors like this were buried with both men and women, usually alongside combs, kohl and ointment containers.

### `tutankhamun-galleries-en`  ·  EN  ·  verified
Entity: tutankhamun-galleries  ·  Source: [Group Guided Tour](https://gem.eg/en/visit/plan-your-visit/tours/group-guided-tour/)

> The museum calls the Tutankhamun Galleries the true heart of the museum, where over 5,000 artefacts from the young king's tomb are displayed together for the first time.

### `golden-burial-mask-en`  ·  EN  ·  verified
Entity: golden-burial-mask  ·  Source: [Artefact: The Golden Burial Mask of Tutankhamun](https://gem.eg/en/collection/artefacts/the-golden-burial-mask-of-tutankhamun)

> The golden burial mask of Tutankhamun is made of solid gold and is one of the most famous objects in the world. It was found over the head and shoulders of the king's mummy. It shows him as the god Osiris and as the sun god Re, and also as a true portrait of his face. An inscription on the back links parts of the mask with different gods.

### `royal-diadem-en`  ·  EN  ·  verified
Entity: royal-diadem  ·  Source: [Artefact: Royal Diadem](https://gem.eg/en/collection/artefacts/royal-diadem)

> The royal diadem lay under the golden mask and encircled the king's head. Its solid-gold headband is decorated with red carnelian discs and blue glass squares. A removable vulture and cobra, symbols of rule over Upper and Lower Egypt, fit onto the front.

### `outer-coffin-en`  ·  EN  ·  verified
Entity: outer-coffin  ·  Source: [Artefact: Outer Coffin](https://gem.eg/en/collection/artefacts/outer-coffin)

> This is the largest of the three coffins found inside Tutankhamun's sarcophagus. It is human-shaped and shows the king as a mummy with crossed hands. The wooden body is covered with plaster, linen and thin gold foil, while the face, ears, neck and hands are covered with thicker hammered gold sheet.

### `golden-throne-en`  ·  EN  ·  verified
Entity: golden-throne  ·  Source: [Artefact: Golden Throne](https://gem.eg/en/collection/artefacts/golden-throne)

> The golden throne is a wooden armchair covered with sheets of gold and inlaid with glass, faience and semi-precious stones, found wrapped in linen in the Antechamber. The back shows the king and queen under a floral canopy beneath the rays of the Aten sun disk. Although adult-sized, it probably dates to the start of his reign.

### `canopic-chest-en`  ·  EN  ·  verified
Entity: canopic-chest  ·  Source: [Artefact: Canopic Chest](https://gem.eg/en/collection/artefacts/canopic-chest)

> Tutankhamun's canopic chest is shaped like a ritual shrine and sits on a gold-covered sledge. It has four cylindrical hollows that held four solid-gold miniature coffins, each closed by a stopper carved as a royal head. The goddesses Isis, Nephthys, Selket and Neith are carved at its corners.

### `guardian-statues-en`  ·  EN  ·  verified
Entity: guardian-statues  ·  Source: [Artefact: Guardian Statue with Nemes Headcloth](https://gem.eg/en/collection/artefacts/guardian-statue-with-nemes-headcloth)

> Two almost identical life-sized statues of Tutankhamun stood facing each other before the sealed doorway to his burial chamber. One wears the nemes headcloth and the other the khat headdress; each holds a staff and a mace. They may represent the king and his ka (spirit), and the black colour evokes the Nile's fertile silt and resurrection.

### `anubis-on-a-chest-en`  ·  EN  ·  verified
Entity: anubis-on-a-chest  ·  Source: [Artefact: Anubis on a Chest](https://gem.eg/en/collection/artefacts/anubis-on-a-chest)

> This large carrying chest was found just inside the Treasury of the tomb. It is shaped like a temple pylon gateway and fixed on a gilded sledge with carrying poles. A black-and-gold jackal figure of Anubis, god of mummification and guardian of the necropolis, sits on top. Inside were compartments for cult objects and jewellery.

### `model-funerary-bed-en`  ·  EN  ·  verified
Entity: model-funerary-bed  ·  Source: [Artefact: Model of Tutankhamun on a Funerary Bed](https://gem.eg/en/collection/artefacts/model-of-tutankhamun-on-a-funerary-bed)

> This wooden model shows the king as a mummy lying on a lion-headed funerary bed, with a human-headed bird representing his ba (spirit) and a falcon, probably the king as the god Horus. Inscriptions say it was a gift to the king from Maya, 'Overseer of Works in the Valley of the Kings'.

### `khufus-boats-museum-en`  ·  EN  ·  single_source
Entity: khufus-boats-museum  ·  Source: [News: King Khufu's Boat Transferred to the Grand Egyptian Museum (7 Aug 2021)](https://gem.eg/en/whats-on/news/king-khufus-boat-transferred-to-the-grand-egyptian-museum/)

> Khufu's Boats Museum is one of the areas included with a visit. In a news item dated 7 August 2021 the museum reported that King Khufu's first boat had arrived at GEM, secured inside two frames, one of wood and one of metal, for the transfer. The official pages reviewed give no further visitor details, so this assistant does not describe the boat's display or opening conditions.

### `gem-history-timeline-ar`  ·  AR  ·  verified
Entity: (general)  ·  Source: [قصة المتحف](https://gem.eg/ar/about/museum-story/)  ·  Arabic basis: official Arabic page

> من قصة المتحف على موقعه الرسمي: في عام 1992 خُصصت أرض بالقرب من أهرامات الجيزة للمشروع؛ وفي 2002 وُضع حجر الأساس؛ وفي 2003 فازت شركة هينيجان بنج المعمارية الإيرلندية بمسابقة تصميم المتحف؛ وبين 2005 و2008 انطلقت أعمال الإنشاء؛ وفي 2010 افتُتح مركز الترميم؛ وفي 2018 استقبل البهو العظيم تمثال الملك رمسيس الثاني ليكون أول قطعة أثرية تستقر في المتحف؛ وفي 2023 افتُتح الدرج العظيم جزئيًا؛ وفي 2024 افتُتحت قاعات العرض الرئيسة جزئيًا؛ وفي 2025 افتُتح المتحف بالكامل.

### `gem-complex-size-ar`  ·  AR  ·  verified
Entity: (general)  ·  Source: [خريطة المتحف](https://gem.eg/ar/visit/plan-your-visit/museum-maps/)  ·  Arabic basis: official Arabic page

> تبلغ مساحة المتحف المصري الكبير نحو 500 ألف متر مربع. ويتألف المبنى الرئيسي من قسمين: القسم المتحفي بمساحة 92 ألف متر مربع، والقسم التجاري بمساحة 40 ألف متر مربع، ويمكن الوصول إلى كل منهما عبر البهو العظيم الذي يتوسطه تمثال رمسيس الثاني.

### `gem-ticket-includes-ar` ⏱  ·  AR  ·  verified
Entity: (general)  ·  Source: [Official Ticketing Website](https://tickets.gem.eg/)  ·  Arabic basis: translated from the English page

> بحسب موقع التذاكر الرسمي، تشمل الزيارة قاعات توت عنخ آمون، وقاعات العرض الرئيسة، والبهو العظيم، والدرج العظيم، ومتحف مراكب الملك خوفو، والمنطقة التجارية، والحدائق الخارجية. تأكد دائمًا من الموقع الرسمي.

### `gem-official-tickets-ar` ⏱  ·  AR  ·  verified
Entity: (general)  ·  Source: [Official Ticketing Website](https://tickets.gem.eg/)  ·  Arabic basis: translated from the English page

> الموقع tickets.gem.eg هو الموقع الرسمي الوحيد لشراء تذاكر المتحف المصري الكبير، والمتحف غير مسؤول عن التذاكر المشتراة من منصات أخرى. أما الحجز الذي يتم داخل GEM Explorer فهو نموذج تجريبي لمشروع طلابي وليس تذكرة للمتحف.

### `gem-guided-tour-ar` ⏱  ·  AR  ·  verified
Entity: (general)  ·  Source: [الأسئلة الأكثر شيوعاً](https://gem.eg/ar/faqs/)  ·  Arabic basis: official Arabic page

> مدة الجولة الإرشادية القياسية نحو ساعتين، وتشمل قاعات توت عنخ آمون والبهو العظيم والدرج العظيم والقاعات الرئيسة.

### `gem-tour-sequence-ar` ⏱  ·  AR  ·  verified
Entity: (general)  ·  Source: [جولة المتحف الإرشادية](https://gem.eg/ar/visit/plan-your-visit/tours/group-guided-tour/)  ·  Arabic basis: official Arabic page

> يسير وصف المتحف لجولة المجموعات بهذا التسلسل: المسلة المعلقة، ثم البهو العظيم، ثم الدرج العظيم، ثم قاعات العرض الرئيسية، وأخيرًا قاعات توت عنخ آمون. هذا هو ترتيب وصف الجولة، وليس معلومة عن المسافات أو زمن المشي.

### `gem-private-tour-ar` ⏱  ·  AR  ·  verified
Entity: (general)  ·  Source: [Private Tour](https://gem.eg/en/visit/plan-your-visit/tours/private-tour/)  ·  Arabic basis: translated from the English page

> يمكن ترتيب جولات خاصة في قاعات العرض الرئيسة لشخص أو لمجموعة، وتُصمم بحسب لغتهم واهتماماتهم وإيقاع زيارتهم.

### `gem-collection-range-ar`  ·  AR  ·  verified
Entity: (general)  ·  Source: [المجموعات الأثرية](https://gem.eg/ar/collection/)  ·  Arabic basis: official Arabic page

> تمتد مجموعات المتحف المصري الكبير من عصور ما قبل التاريخ حتى العصرين اليوناني والروماني، وتعرض صفحات المجموعة كل قطعة أثرية مع حقبتها وأسرتها ومادة صنعها ومكان العثور عليها.

### `hanging-obelisk-ar`  ·  AR  ·  verified
Entity: hanging-obelisk  ·  Source: [قطعة أثرية: مسلة الملك رمسيس الثاني](https://gem.eg/ar/collection/artefacts/obelisk-of-king-ramesses-ii)  ·  Arabic basis: official Arabic page

> المسلة المعلقة للملك رمسيس الثاني تقف في ساحة مساحتها ثلاثون ألف متر مربع أمام المدخل الرئيسي للمتحف. وهي مرفوعة على منصة تدعمها أربعة أعمدة ضخمة، حتى يتمكن الزوار من رؤية خراطيش الملك المنحوتة في أسفلها.

### `grand-hall-ar`  ·  AR  ·  verified
Entity: grand-hall  ·  Source: [خريطة المتحف](https://gem.eg/ar/visit/plan-your-visit/museum-maps/)  ·  Arabic basis: official Arabic page

> البهو العظيم هو مدخل القسم المتحفي والقسم التجاري في المبنى الرئيسي، ويتوسطه تمثال رمسيس الثاني.

### `grand-hall-highlights-ar`  ·  AR  ·  verified
Entity: grand-hall  ·  Source: [المجموعات الأثرية: البهو العظيم](https://gem.eg/ar/collection/grand-hall/)  ·  Arabic basis: official Arabic page

> تذكر صفحة البهو العظيم على موقع المتحف من أهم قطعه: تمثال حجري ضخم للملك رمسيس الثاني، وعمود الملك مرنبتاح، وتمثال لملك بطلمي، وتمثال لملكة بطلمية.

### `grand-stairs-ar`  ·  AR  ·  verified
Entity: grand-stairs  ·  Source: [جولة المتحف الإرشادية](https://gem.eg/ar/visit/plan-your-visit/tours/group-guided-tour/)  ·  Arabic basis: official Arabic page

> يضم الدرج العظيم 59 قطعة أثرية بحسب وصف المتحف، ويأتي في جولة المتحف بعد البهو العظيم وقبل قاعات العرض الرئيسية.

### `grand-stairs-highlights-ar`  ·  AR  ·  verified
Entity: grand-stairs  ·  Source: [المجموعات الأثرية: الدرج العظيم](https://gem.eg/ar/collection/grand-stairs/)  ·  Arabic basis: official Arabic page

> من أهم القطع التي تعرضها صفحة الدرج العظيم: تمثال المعبود بتاح والملك رمسيس الثاني مع المعبودة سخمت، وتمثال للمعبودة سخمت على هيئة اللبؤة، وتاج عمود حتحوري، وقمة مسلة للملكة حتشبسوت.

### `main-galleries-ar`  ·  AR  ·  verified
Entity: main-galleries  ·  Source: [جولة المتحف الإرشادية](https://gem.eg/ar/visit/plan-your-visit/tours/group-guided-tour/)  ·  Arabic basis: official Arabic page

> تتكون قاعات العرض الرئيسة (وتُكتب أيضًا: القاعات الرئيسية) من اثنتي عشرة قاعة منسقة بعناية تحكي قصة الحضارة المصرية من عصور ما قبل التاريخ حتى العصرين اليوناني والروماني. لا تذكر الصفحات الرسمية التي راجعناها أسماء القاعات ولا أرقامها، لذلك لا يصف المساعد أرقام القاعات أو توزيعها.

### `main-galleries-themes-ar`  ·  AR  ·  verified
Entity: main-galleries  ·  Source: [خبر: المتحف المصري الكبير يعلن عن التشغيل التجريبي لقاعات العرض الرئيسية](https://gem.eg/ar/whats-on/news/grand-egyptian-museum-announces-trial-operations-of-main-galleries/)  ·  Arabic basis: official Arabic page

> بحسب خبر على موقع المتحف، تأخذ قاعات العرض الرئيسية الزائر في رحلة من عصور ما قبل التاريخ (نحو 700,000 قبل الميلاد) حتى العصر الروماني (نحو 394 ميلادية) عبر ثلاثة موضوعات: الملكية والمجتمع والمعتقدات. ويمكن استكشافها بتسلسل زمني أو بحسب موضوعات محددة أو بأسلوب تفاعلي مخصص لاهتمامات الزائر.

### `tutankhamun-galleries-ar`  ·  AR  ·  verified
Entity: tutankhamun-galleries  ·  Source: [جولة المتحف الإرشادية](https://gem.eg/ar/visit/plan-your-visit/tours/group-guided-tour/)  ·  Arabic basis: official Arabic page

> يصف المتحف قاعات توت عنخ آمون (قاعات عرض كنوز توت عنخ آمون) بأنها قلب المتحف النابض، حيث تُعرض أكثر من 5000 قطعة أثرية من مقبرة الملك الشاب مجتمعة لأول مرة.

### `khufus-boats-museum-ar`  ·  AR  ·  single_source
Entity: khufus-boats-museum  ·  Source: [News: King Khufu's Boat Transferred to the Grand Egyptian Museum (7 Aug 2021)](https://gem.eg/en/whats-on/news/king-khufus-boat-transferred-to-the-grand-egyptian-museum/)  ·  Arabic basis: translated from the English page

> متحف مراكب الملك خوفو من الأماكن المشمولة بالزيارة. وفي خبر منشور بتاريخ 7 أغسطس 2021 أعلن المتحف وصول مركب الملك خوفو الأولى إلى المتحف المصري الكبير بعد تأمينها داخل إطارين أحدهما من الخشب والآخر من المعدن أثناء النقل. لا تذكر الصفحات الرسمية التي راجعناها تفاصيل أخرى للزائر، لذلك لا يصف المساعد طريقة عرض المركب أو شروط الزيارة.

### `hanging-obelisk-wording-ar`  ·  AR  ·  verified
Entity: hanging-obelisk  ·  Source: [قطعة أثرية: مسلة الملك رمسيس الثاني](https://gem.eg/ar/collection/artefacts/obelisk-of-king-ramesses-ii)  ·  Arabic basis: official Arabic page

> تصف صفحة المتحف الرسمية العربية المسلة المعلقة بأنها أول مسلة معلقة في العالم وأول قطعة تستقبل الزوار. هذه صياغة المتحف نفسه ولم نتحقق منها بشكل مستقل، لذلك تُعرض على أنها وصف المتحف.

### `obelisk-ramesses-ii-ar`  ·  AR  ·  verified
Entity: obelisk-ramesses-ii  ·  Source: [قطعة أثرية: مسلة الملك رمسيس الثاني](https://gem.eg/ar/collection/artefacts/obelisk-of-king-ramesses-ii)  ·  Arabic basis: official Arabic page

> شيّد الملك رمسيس الثاني أكثر من عشر مسلات في تانيس (صان الحجر) بشرق الدلتا. وهذه المسلة الجرانيتية ارتفاعها 16 مترًا ووزنها 87 طنًا، وهي أطول مسلة أقيمت في تانيس. نُقش على جوانبها الأربعة اسم حورس واسم التتويج واسم الميلاد للملك.

### `colossal-statue-ramesses-ii-ar`  ·  AR  ·  verified
Entity: colossal-statue-ramesses-ii  ·  Source: [قطعة أثرية: تمثال حجري ضخم للملك رمسيس الثاني](https://gem.eg/ar/collection/artefacts/colossal-statue-of-ramesses-ii)  ·  Arabic basis: official Arabic page

> التمثال الحجري الضخم للملك رمسيس الثاني مصنوع من الجرانيت، وارتفاعه نحو 11.35 مترًا، ويعود إلى الدولة الحديثة (الأسرة التاسعة عشرة) وعُثر عليه في منف (ميت رهينة). أُقيم في الأصل خارج المعبد الرئيسي للمعبود بتاح في منف، ويظهر خلف ساقي الملك نقش لاثنين من أبنائه هما الأمير خع-ام-واست والأميرة بنت-عنات.

### `colossal-statue-arrival-ar`  ·  AR  ·  verified
Entity: colossal-statue-ramesses-ii  ·  Source: [قصة المتحف](https://gem.eg/ar/about/museum-story/)  ·  Arabic basis: official Arabic page

> كان تمثال الملك رمسيس الثاني أول قطعة أثرية تستقر في المتحف، إذ استقبله البهو العظيم في عام 2018.

### `seated-statue-sekhmet-ar`  ·  AR  ·  verified
Entity: seated-statue-sekhmet  ·  Source: [قطعة أثرية: تمثال للمعبودة سخمت على هيئة اللبؤة](https://gem.eg/ar/collection/artefacts/seated-statue-of-goddess-sekhmet)  ·  Arabic basis: official Arabic page

> يُظهر هذا التمثال المعبودة سخمت التي يعني اسمها «القوية»، وقد ارتبطت بالنار والدمار، وكانت أيضًا المعبودة المسؤولة عن حماية الملك. أقام الملك أمنحتب الثالث تماثيل لها في معبده الجنائزي على الضفة الغربية بطيبة، ثم نُقل عدد منها بعد نحو 300 عام إلى الضفة الشرقية حيث وُضعت في معبد المعبودة موت بالكرنك. عنوانه على موقع المتحف: «تمثال للمعبودة سخمت على هيئة اللبؤة».

### `doorway-amenemhat-i-ar`  ·  AR  ·  verified
Entity: doorway-amenemhat-i  ·  Source: [قطعة أثرية: بوابة للملك أمنمحات الأول](https://gem.eg/ar/collection/artefacts/doorway-of-king-amenemhat-i)  ·  Arabic basis: official Arabic page

> اكتُشفت أجزاء هذه البوابة، وهي عتب وعضادتان من الجرانيت، عام 1883 في «عزبة حلمي» بشرق الدلتا (الدولة الوسطى، الأسرة الثانية عشرة). تشير النقوش المحفورة عليها إلى أن الملك أمنمحات الأول شيّد مبنى، وإلى أن الملك سنوسرت الثالث جدّد هذا الأثر بعده بنحو مائة عام.

### `standing-statue-thutmose-iii-ar`  ·  AR  ·  verified
Entity: standing-statue-thutmose-iii  ·  Source: [قطعة أثرية: تمثال للملك تحتمس الثالث](https://gem.eg/ar/collection/artefacts/standing-statue-of-king-thutmose-iii)  ·  Arabic basis: official Arabic page

> اكتُشف هذا التمثال الجرانيتي عام 1860 في معبد آمون رع بالكرنك. يرتدي الملك غطاء الرأس «النمس» ولحية مستعارة ونقبة بقسم أمامي بارز. ورغم أن الخرطوش على حزام النقبة يحمل اسم تحتمس الثالث، لا تزال آثار اسم ملكي آخر ظاهرة، ويُحتمل أن التمثال صُنع في الأصل للملكة حتشبسوت ثم نُسب لاحقًا إلى ربيبها تحتمس الثالث.

### `ramesses-ii-and-a-goddess-ar`  ·  AR  ·  verified
Entity: ramesses-ii-and-a-goddess  ·  Source: [قطعة أثرية: تمثال للملك رمسيس الثاني وإحدى المعبودات](https://gem.eg/ar/collection/artefacts/king-ramesses-ii-and-a-goddess)  ·  Arabic basis: official Arabic page

> اكتُشفت أجزاء من هذا التمثال الجرانيتي الأحمر عام 1825 في معبد آمون الكبير بتانيس (صان الحجر). يصور التمثال الملك رمسيس الثاني وإحدى المعبودات، ربما المعبودة عِنات التي كانت حامية الملك؛ فهي تلمس تاج الملك بيدها اليمنى وتضع يدها اليسرى على ذراعه. ولا يحمل التمثال نقشًا باسم الملك، لكن نسبته إلى رمسيس الثاني تستند إلى سياق الكشف عن عدد كبير من منحوتاته في تانيس وإلى سماته الفنية.

### `sarcophagus-djehutymose-ar`  ·  AR  ·  verified
Entity: sarcophagus-djehutymose  ·  Source: [قطعة أثرية: تابوت جحوتي مس](https://gem.eg/ar/collection/artefacts/sarcophagus-of-djehutymose)  ·  Arabic basis: official Arabic page

> عُثر على هذا التابوت الجرانيتي الضخم عام 1915 داخل بئر للدفن بمنطقة تونا الجبل. حمل صاحبه «جحوتي مس» ألقابًا إدارية وكهنوتية مهمة في الأسرة التاسعة عشرة، منها «المشرف على الأعمال في معبد جحوتي». ويصور غطاء التابوت المتوفى على هيئة مومياء، كما صُورت عليه المعبودة نوت بجناحين مبسوطين في وضع الحماية.

### `mirror-of-mesehti-ar`  ·  AR  ·  verified
Entity: mirror-of-mesehti  ·  Source: [قطعة أثرية: مرآة برونزية لمسحتي](https://gem.eg/ar/collection/artefacts/mirror-of-mesehti)  ·  Arabic basis: official Arabic page

> عُثر على هذه المرآة البرونزية ضمن مقتنيات النبيل مسحتي، حاكم إقليم أسيوط في الأسرة الحادية عشرة (الدولة الوسطى). وهي مصنوعة من البرونز ولها مقبض خشبي صُورت على جانبيه عينا «الودجات». استُخدمت المرايا ضمن لوازم التجميل في مصر القديمة، وكان امتلاكها مؤشرًا على الترف، وقد دُفنت ضمن الأثاث الجنائزي للرجال والنساء. عنوانها على موقع المتحف: «مرآة برونزية لمسحتي».

### `golden-burial-mask-ar`  ·  AR  ·  verified
Entity: golden-burial-mask  ·  Source: [قطعة أثرية: قناع الدفن الذهبي للملك توت عنخ آمون](https://gem.eg/ar/collection/artefacts/the-golden-burial-mask-of-tutankhamun)  ·  Arabic basis: official Arabic page

> قناع الدفن الذهبي للملك توت عنخ آمون مصنوع من الذهب، وهو من أشهر القطع الأثرية في العالم. عُثر عليه موضوعًا على رأس وكتفي مومياء الملك، ويصوره كأنه أوزير حاكم العالم الآخر ورع معبود الشمس، كما يُعد نسخة مثالية من ملامح وجهه المعروفة من التوابيت والتماثيل ومناظر المعابد. ويحمي النقش على ظهر القناع رأس الملك بربط أجزائه بمعبودات مختلفة؛ فالجبهة تُنسب إلى أنوبيس.

### `royal-diadem-ar`  ·  AR  ·  verified
Entity: royal-diadem  ·  Source: [Artefact: Royal Diadem](https://gem.eg/en/collection/artefacts/royal-diadem)  ·  Arabic basis: translated from the English page

> الإكليل الملكي وُجد تحت القناع الذهبي وكان يحيط برأس الملك. عصابته من الذهب الخالص مزينة بأقراص من العقيق الأحمر ومربعات من الزجاج الأزرق، ويُثبت في مقدمته نسر وكوبرا قابلان للفصل، وهما رمزان للحكم على مصر العليا والسفلى.

### `outer-coffin-ar`  ·  AR  ·  verified
Entity: outer-coffin  ·  Source: [قطعة أثرية: التابوت الخارجي](https://gem.eg/ar/collection/artefacts/outer-coffin)  ·  Arabic basis: official Arabic page

> التابوت الخارجي هو الأكبر بين ثلاثة توابيت عُثر عليها داخل التابوت الحجري للملك توت عنخ آمون. يظهر بهيئة آدمية على شكل مومياء معقودة اليدين على الصدر. صُنع من الخشب المغطى بطبقة من الجص والكتان ورقائق رقيقة من الذهب، بينما غُطي وجه الملك وأذناه وعنقه ويداه برقائق ذهب أكثر سمكًا. ويروي هوارد كارتر أنه دُهش عند رؤيته بعد رفع غطاء التابوت الحجري وإزالة طبقتين من اللفائف الكتانية.

### `golden-throne-ar`  ·  AR  ·  verified
Entity: golden-throne  ·  Source: [Artefact: Golden Throne](https://gem.eg/en/collection/artefacts/golden-throne)  ·  Arabic basis: translated from the English page

> كرسي العرش الذهبي كرسي خشبي مغطى بصفائح الذهب ومطعم بالزجاج والفيانس والأحجار شبه الكريمة، عُثر عليه ملفوفًا بالكتان في الغرفة الأمامية للمقبرة. يصور ظهره الملك والملكة تحت مظلة زهرية أسفل أشعة قرص آتون. ورغم أن حجمه حجم رجل بالغ، يُرجَّح أنه يعود إلى بداية حكم الملك.

### `canopic-chest-ar`  ·  AR  ·  verified
Entity: canopic-chest  ·  Source: [قطعة أثرية: صندوق الأواني الكانوبية](https://gem.eg/ar/collection/artefacts/canopic-chest)  ·  Arabic basis: official Arabic page

> صندوق الأواني الكانوبية للملك توت عنخ آمون مصمم على هيئة مقصورة طقسية بغطاء مائل مثبت بحبال من الكتان، ويستقر على زلاجة خشبية مذهبة. يحتوي على أربع فجوات أسطوانية يعلو كل منها غطاء على شكل رأس ملكي، ضمت أربعة توابيت صغيرة من الذهب الخالص لحفظ أحشاء الملك التي نُزعت أثناء التحنيط. وتزين أركانه نقوش بارزة للمعبودات الحاميات إيزيس ونفتيس وسرقت ونيت.

### `guardian-statues-ar`  ·  AR  ·  verified
Entity: guardian-statues  ·  Source: [قطعة أثرية: تمثال الـكا (غطاء الرأس الخات)](https://gem.eg/ar/collection/artefacts/guardian-statue-with-khat-headdress)  ·  Arabic basis: official Arabic page

> عُثر على تمثالين للملك توت عنخ آمون أمام مدخل غرفة الدفن في مقبرته، وتحاكي بعض ملامحهما فن العمارنة. يعبر التمثالان في الأغلب عن الملك والـ«كا» الخاصة به (الروح). يسمي موقع المتحف كل واحد منهما «تمثال الـكا»، وفي أحدهما يرتدي الملك غطاء الرأس المعروف بـ«الخات».

### `guardian-statues-nemes-ar`  ·  AR  ·  verified
Entity: guardian-statues  ·  Source: [قطعة أثرية: تمثال الـكا (غطاء الرأس النمس)](https://gem.eg/ar/collection/artefacts/guardian-statue-with-nemes-headcloth)  ·  Arabic basis: official Arabic page

> في التمثال الثاني من تمثالي الـكا يرتدي الملك غطاء الرأس «النمس» ومئزرًا ملكيًا نُقش على مقدمته اسم توت عنخ آمون ودعاء بأن يُعطى الحياة للأبد مثل رع كل يوم. ويحاكي اللون الأسود للتمثال لون التربة المصرية الخصبة التي يجلبها فيضان النيل، كما يرمز للبعث.

### `anubis-on-a-chest-ar`  ·  AR  ·  verified
Entity: anubis-on-a-chest  ·  Source: [قطعة أثرية: أنوبيس رابض فوق صندوق طقسي](https://gem.eg/ar/collection/artefacts/anubis-on-a-chest)  ·  Arabic basis: official Arabic page

> عُثر على هذا الصندوق الخشبي الكبير في حجرة الخزانة بمقبرة توت عنخ آمون، وهو مصمم على هيئة جدران الصرح في المعبد المصري القديم، ومثبت على محفة خشبية مذهبة ذات حوامل طويلة. يعلوه تمثال مطلي بالأسود والذهبي للمعبود أنوبيس، رب التحنيط وحارس الجبانة، في هيئة ابن آوى. ويضم من الداخل أربع فجوات صغيرة لأدوات طقسية ملفوفة بالكتان وفجوة كبيرة لحفظ الحلي. عنوانه على موقع المتحف: «أنوبيس رابض فوق صندوق طقسي».

### `model-funerary-bed-ar`  ·  AR  ·  verified
Entity: model-funerary-bed  ·  Source: [قطعة أثرية: تمثال للملك راقداً على النعش](https://gem.eg/ar/collection/artefacts/model-of-tutankhamun-on-a-funerary-bed)  ·  Arabic basis: official Arabic page

> عُثر على هذا التمثال الخشبي الصغير ملفوفًا بالكتان داخل صندوق خشبي صغير على هيئة تابوت ضم أيضًا خمسة نماذج لأدوات تماثيل الشابتي. يصور الملك على هيئة مومياء راقدة على سرير جنائزي برأس أسد، وعند مرفقيه صقر يمثل المعبود حورس وطائر برأس آدمي يمثل «با» الملك أو روحه. وتشير النقوش إلى أنه هدية للملك من «مايا» المشرف على الأعمال في وادي الملوك. عنوانه على موقع المتحف: «تمثال للملك راقداً على النعش».

## Source pages used

- [Museum Story](https://gem.eg/en/about/museum-story/)
- [GEM Complex Map](https://gem.eg/visit/plan-your-visit/museum-maps/)
- [Official Ticketing Website](https://tickets.gem.eg/)
- [Group Guided Tour](https://gem.eg/en/visit/plan-your-visit/tours/group-guided-tour/)
- [Private Tour](https://gem.eg/en/visit/plan-your-visit/tours/private-tour/)
- [FAQs](https://gem.eg/faqs/)
- [Collection: Treasures of GEM](https://gem.eg/collection/)
- [Collection: Grand Stairs](https://gem.eg/collection/grand-stairs/)
- [Collection: Grand Hall](https://gem.eg/collection/grand-hall/)
- [News: King Khufu's Boat Transferred to the Grand Egyptian Museum (7 Aug 2021)](https://gem.eg/en/whats-on/news/king-khufus-boat-transferred-to-the-grand-egyptian-museum/)
- [Artefact: Colossal Statue of Ramesses II](https://gem.eg/en/collection/artefacts/colossal-statue-of-ramesses-ii)
- [Artefact: Obelisk of King Ramesses II](https://gem.eg/en/collection/artefacts/obelisk-of-king-ramesses-ii)
- [Artefact: Seated Statue of Goddess Sekhmet](https://gem.eg/en/collection/artefacts/seated-statue-of-goddess-sekhmet)
- [Artefact: Doorway of King Amenemhat I](https://gem.eg/en/collection/artefacts/doorway-of-king-amenemhat-i)
- [Artefact: Standing Statue of King Thutmose III](https://gem.eg/en/collection/artefacts/standing-statue-of-king-thutmose-iii)
- [Artefact: King Ramesses II and a Goddess](https://gem.eg/en/collection/artefacts/king-ramesses-ii-and-a-goddess)
- [Artefact: Sarcophagus of Djehutymose](https://gem.eg/en/collection/artefacts/sarcophagus-of-djehutymose)
- [Artefact: The Golden Burial Mask of Tutankhamun](https://gem.eg/en/collection/artefacts/the-golden-burial-mask-of-tutankhamun)
- [Artefact: Royal Diadem](https://gem.eg/en/collection/artefacts/royal-diadem)
- [Artefact: Outer Coffin](https://gem.eg/en/collection/artefacts/outer-coffin)
- [Artefact: Golden Throne](https://gem.eg/en/collection/artefacts/golden-throne)
- [Artefact: Canopic Chest](https://gem.eg/en/collection/artefacts/canopic-chest)
- [Artefact: Guardian Statue with Khat Headdress](https://gem.eg/en/collection/artefacts/guardian-statue-with-khat-headdress)
- [Artefact: Guardian Statue with Nemes Headcloth](https://gem.eg/en/collection/artefacts/guardian-statue-with-nemes-headcloth)
- [Artefact: Anubis on a Chest](https://gem.eg/en/collection/artefacts/anubis-on-a-chest)
- [Artefact: Model of Tutankhamun on a Funerary Bed](https://gem.eg/en/collection/artefacts/model-of-tutankhamun-on-a-funerary-bed)
- [Artefact: Mirror of Mesehti](https://gem.eg/en/collection/artefacts/mirror-of-mesehti)
- [قصة المتحف](https://gem.eg/ar/about/museum-story/)
- [خريطة المتحف](https://gem.eg/ar/visit/plan-your-visit/museum-maps/)
- [جولة المتحف الإرشادية](https://gem.eg/ar/visit/plan-your-visit/tours/group-guided-tour/)
- [الأسئلة الأكثر شيوعاً](https://gem.eg/ar/faqs/)
- [المجموعات الأثرية](https://gem.eg/ar/collection/)
- [المجموعات الأثرية: البهو العظيم](https://gem.eg/ar/collection/grand-hall/)
- [المجموعات الأثرية: الدرج العظيم](https://gem.eg/ar/collection/grand-stairs/)
- [المجموعات الأثرية: قاعات العرض الرئيسة](https://gem.eg/ar/collection/main-galleries/)
- [المجموعات الأثرية: قاعات عرض كنوز توت عنخ آمون](https://gem.eg/ar/collection/tutankhamun-galleries/)
- [خبر: المتحف المصري الكبير يعلن عن التشغيل التجريبي لقاعات العرض الرئيسية](https://gem.eg/ar/whats-on/news/grand-egyptian-museum-announces-trial-operations-of-main-galleries/)
- [قطعة أثرية: قناع الدفن الذهبي للملك توت عنخ آمون](https://gem.eg/ar/collection/artefacts/the-golden-burial-mask-of-tutankhamun)
- [قطعة أثرية: مسلة الملك رمسيس الثاني](https://gem.eg/ar/collection/artefacts/obelisk-of-king-ramesses-ii)
- [قطعة أثرية: تمثال حجري ضخم للملك رمسيس الثاني](https://gem.eg/ar/collection/artefacts/colossal-statue-of-ramesses-ii)
- [قطعة أثرية: تمثال للملك رمسيس الثاني وإحدى المعبودات](https://gem.eg/ar/collection/artefacts/king-ramesses-ii-and-a-goddess)
- [قطعة أثرية: تمثال للمعبودة سخمت على هيئة اللبؤة](https://gem.eg/ar/collection/artefacts/seated-statue-of-goddess-sekhmet)
- [قطعة أثرية: بوابة للملك أمنمحات الأول](https://gem.eg/ar/collection/artefacts/doorway-of-king-amenemhat-i)
- [قطعة أثرية: تمثال للملك تحتمس الثالث](https://gem.eg/ar/collection/artefacts/standing-statue-of-king-thutmose-iii)
- [قطعة أثرية: تابوت جحوتي مس](https://gem.eg/ar/collection/artefacts/sarcophagus-of-djehutymose)
- [قطعة أثرية: التابوت الخارجي](https://gem.eg/ar/collection/artefacts/outer-coffin)
- [قطعة أثرية: صندوق الأواني الكانوبية](https://gem.eg/ar/collection/artefacts/canopic-chest)
- [قطعة أثرية: تمثال الـكا (غطاء الرأس الخات)](https://gem.eg/ar/collection/artefacts/guardian-statue-with-khat-headdress)
- [قطعة أثرية: تمثال الـكا (غطاء الرأس النمس)](https://gem.eg/ar/collection/artefacts/guardian-statue-with-nemes-headcloth)
- [قطعة أثرية: أنوبيس رابض فوق صندوق طقسي](https://gem.eg/ar/collection/artefacts/anubis-on-a-chest)
- [قطعة أثرية: تمثال للملك راقداً على النعش](https://gem.eg/ar/collection/artefacts/model-of-tutankhamun-on-a-funerary-bed)
- [قطعة أثرية: مرآة برونزية لمسحتي](https://gem.eg/ar/collection/artefacts/mirror-of-mesehti)
