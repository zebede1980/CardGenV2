// The "look" half of an image prompt — how a picture is shot or drawn, kept
// apart from the subject (an idea, or a character card) so one look can be
// reused across Playground and Character Gen. Shared by the prompt writer
// (writeImagePrompt in api-image.js) and the Prompt Builder sheet
// (prompt-builder.js).
//
// A look is { name, picks: { groupKey: [option, ...] }, extra, fromImage }.
// A group with no picks means "AI decides": the writer chooses something that
// fits. Saved looks live in config as api.image.looks ([{ id, name, picks,
// extra, fromImage }]); Character Gen's active look is api.image.activeLook, a
// JSON string — config is deep-merged on load, and a string can't keep stale
// keys from an older object the way a merged object would.

(function () {
  const SECTIONS = [
    { id: "medium", name: "Medium & genre", groups: [
      { key: "medium", label: "Medium & genre", single: true, opts: [
        "Analog film photo", "Digital photo", "Studio portrait photo", "Cinematic film still",
        "2.5D semi-realistic anime", "Anime illustration", "Manhwa cover art", "Digital painting",
        "Oil painting", "Watercolour", "Ink sketch", "Comic book art", "3D render", "Concept art", "Pixel art",
      ] } ] },
    { id: "shot", name: "Shot", groups: [
      { key: "framing", label: "Framing", single: true, opts: ["Close-up", "Head & shoulders", "Waist-up", "Three-quarter length", "Full body", "Wide scene"] },
      { key: "angle", label: "Angle", single: true, opts: ["Eye level", "Low angle", "High angle", "Overhead", "Three-quarter view", "Profile", "Over the shoulder"] },
      { key: "composition", label: "Composition", single: true, opts: ["Symmetrical frontal", "Rule of thirds", "Centred", "Negative space", "Dutch tilt"] } ] },
    { id: "pose", name: "Pose & expression", groups: [
      { key: "pose", label: "Pose", single: true, opts: ["Standing relaxed", "Hand on hip", "Arms crossed", "Seated", "Leaning", "Walking towards viewer", "Mid-action", "Looking back over shoulder"] },
      { key: "expression", label: "Expression", single: true, opts: ["Neutral", "Soft smile", "Smirk", "Intense stare", "Laughing", "Melancholy", "Determined", "Lips slightly parted"] } ] },
    { id: "lighting", name: "Lighting", groups: [
      { key: "lighting", label: "Lighting", opts: [
        "Creamy soft key", "Soft rim light", "Volumetric haze", "Golden hour", "Blue hour", "Overcast daylight",
        "Neon", "Candlelight", "Studio softbox", "Hard midday sun", "Backlit", "Chiaroscuro",
      ] } ] },
    { id: "optics", name: "Lens & focus", photoOnly: true, groups: [
      { key: "lens", label: "Lens", single: true, opts: ["24mm wide", "35mm", "50mm", "85mm portrait", "135mm telephoto", "Macro"] },
      { key: "focus", label: "Focus", opts: ["Deep focus", "Shallow depth of field", "Extreme bokeh", "Foreground blur", "Motion blur", "Tilt-shift"] } ] },
    { id: "finish", name: "Film & finish", groups: [
      { key: "finish", label: "Film & finish", opts: [
        "Fine film grain", "Heavy grain", "Halation", "Chromatic aberration", "Light leaks", "Slight overexposure",
        "Matte", "Glossy", "Faded blacks", "Cross-processed", "High contrast", "Soft pastel grade",
      ] } ] },
    { id: "materials", name: "Materials & texture", groups: [
      { key: "materials", label: "Materials & texture", custom: true, opts: [
        "Ceramic", "Specular highlights", "Leather", "Silk", "Velvet", "Brushed metal", "Wet skin", "Wool knit", "Lace", "Worn denim",
      ] } ] },
    { id: "palette", name: "Palette", groups: [
      { key: "palette", label: "Palette", custom: true, opts: [
        "White", "Black", "Pastel purple", "Teal & orange", "Amber & slate", "Neon pink & cyan",
        "Earth tones", "Jewel tones", "Monochrome", "Crimson & gold", "Sage & cream",
      ] } ] },
    { id: "background", name: "Background", groups: [
      { key: "background", label: "Background", single: true, custom: true, opts: [
        "From the subject", "Brutalist city", "Neon street", "Studio seamless", "Forest", "Interior",
        "Skyline at dusk", "Ruins", "Abstract gradient", "Plain backdrop",
      ] } ] },
    { id: "mood", name: "Mood", groups: [
      { key: "mood", label: "Mood", single: true, opts: [
        "Bright & cheerful", "Dark & gothic", "Somber", "Romantic & soft", "Energetic", "Mysterious",
        "Seductive", "Epic & heroic", "Dreamy", "Gritty", "Cosy & warm", "Tense",
      ] } ] },
  ];

  // One-line explainers, shown on hover (desktop) and under the group when an
  // option is tapped (phones have no hover). Options the user adds themselves
  // have none.
  const DESCRIPTIONS = {
    "✨ AI decides": "Leave this to the AI: it picks something that suits the picture.",
    // Medium & genre
    "Analog film photo": "Looks shot on real film: soft grain, warm tones, slightly imperfect.",
    "Digital photo": "A clean, sharp modern camera photo.",
    "Studio portrait photo": "Posed portrait in a studio with controlled lighting and a simple backdrop.",
    "Cinematic film still": "Looks like a frame from a movie: widescreen feel, dramatic lighting.",
    "2.5D semi-realistic anime": "Anime faces and styling with realistic shading and depth.",
    "Anime illustration": "Classic 2D anime art: clean lines, flat colour, big expressive eyes.",
    "Manhwa cover art": "Glossy Korean webtoon cover style: polished, semi-realistic, dramatic.",
    "Digital painting": "Painted on a computer: visible brushwork, painterly but crisp.",
    "Oil painting": "Traditional oils on canvas: rich colour and thick brushstrokes.",
    "Watercolour": "Soft, translucent washes of colour that bleed into each other.",
    "Ink sketch": "Pen-and-ink drawing: line work and cross-hatching, little colour.",
    "Comic book art": "Western comic style: bold ink outlines, strong colours.",
    "3D render": "Computer-generated 3D, like a game or animated film.",
    "Concept art": "Production art for films and games: loose, atmospheric, design-focused.",
    "Pixel art": "Retro video-game look made of visible square pixels.",
    // Framing
    "Close-up": "Face fills most of the frame.",
    "Head & shoulders": "Classic portrait crop: head, neck and shoulders.",
    "Waist-up": "From the waist up, so hands and outfit show.",
    "Three-quarter length": "From around the knees up.",
    "Full body": "The whole figure, head to toe.",
    "Wide scene": "Pulled right back: the setting matters as much as the person.",
    // Angle
    "Eye level": "Camera at the subject's eye height: neutral and natural.",
    "Low angle": "Looking up at the subject: makes them look powerful or imposing.",
    "High angle": "Looking down on the subject: makes them look smaller or vulnerable.",
    "Overhead": "Straight down from above, a bird's-eye view.",
    "Three-quarter view": "Body turned partly away, face angled between front and profile.",
    "Profile": "Seen side-on, like a silhouette on a coin.",
    "Over the shoulder": "Viewed from behind, past their shoulder.",
    // Composition
    "Symmetrical frontal": "Dead centre, facing the viewer, balanced left and right.",
    "Rule of thirds": "Subject placed off-centre, a third of the way in: natural and dynamic.",
    "Centred": "Subject in the middle of the frame.",
    "Negative space": "Lots of empty space around the subject, for a minimal, striking look.",
    "Dutch tilt": "Camera tilted at an angle, for unease or energy.",
    // Pose
    "Standing relaxed": "Casual, natural standing pose.",
    "Hand on hip": "Confident pose with one hand on the hip.",
    "Arms crossed": "Arms folded: guarded, stern or self-assured.",
    "Seated": "Sitting down.",
    "Leaning": "Leaning against something, relaxed or cool.",
    "Walking towards viewer": "Mid-stride, coming towards the camera.",
    "Mid-action": "Caught moving: fighting, casting, running.",
    "Looking back over shoulder": "Turned away, glancing back at the viewer.",
    // Expression
    "Neutral": "Calm, unreadable face.",
    "Soft smile": "Gentle, warm smile.",
    "Smirk": "Knowing half-smile: confident or mischievous.",
    "Intense stare": "Fierce, direct eye contact.",
    "Laughing": "Open, genuine laughter.",
    "Melancholy": "Quietly sad or wistful.",
    "Determined": "Set jaw, focused: ready for anything.",
    "Lips slightly parted": "Mouth just open: soft, breathy or alluring.",
    // Lighting
    "Creamy soft key": "Smooth, flattering main light with gentle shadows.",
    "Soft rim light": "A thin glow outlining the edges of hair and body from behind.",
    "Volumetric haze": "Visible beams of light through mist, smoke or dust.",
    "Golden hour": "Warm, low sunlight just after sunrise or before sunset.",
    "Blue hour": "Cool, soft twilight just after sunset.",
    "Overcast daylight": "Flat, even daylight under cloud: soft and shadowless.",
    "Neon": "Coloured light from neon signs: pinks, blues, purples.",
    "Candlelight": "Warm, flickering, low light from candles.",
    "Studio softbox": "Clean, controlled professional studio lighting.",
    "Hard midday sun": "Bright overhead sun with sharp, dark shadows.",
    "Backlit": "Light from behind the subject, often with a glow or silhouette.",
    "Chiaroscuro": "Strong contrast between bright light and deep shadow, like a Rembrandt painting.",
    // Lens
    "24mm wide": "Wide lens: takes in lots of the scene, slightly stretches the edges.",
    "35mm": "Natural, documentary-style view, close to what the eye sees.",
    "50mm": "The classic 'normal' lens: little distortion.",
    "85mm portrait": "Flattering portrait lens: compresses features, softens the background.",
    "135mm telephoto": "Long lens from far away: flat perspective, very blurred background.",
    "Macro": "Extreme close-up of small details.",
    // Focus
    "Deep focus": "Everything sharp, from foreground to background.",
    "Shallow depth of field": "Subject sharp, background softly blurred.",
    "Extreme bokeh": "Background melted into soft blur and round light spots.",
    "Foreground blur": "Out-of-focus objects close to the camera, framing the subject.",
    "Motion blur": "Streaks that show movement.",
    "Tilt-shift": "Odd band of focus that makes scenes look like miniatures.",
    // Film & finish
    "Fine film grain": "A subtle grainy texture, like real film.",
    "Heavy grain": "Strong, gritty grain: raw and vintage.",
    "Halation": "Soft red-orange glow bleeding around bright highlights, a film quirk.",
    "Chromatic aberration": "Slight colour fringing on edges, like an imperfect lens.",
    "Light leaks": "Warm streaks of light washing in, like old film cameras.",
    "Slight overexposure": "Brighter than normal, with highlights blowing out a little: dreamy and airy.",
    "Matte": "Flat, non-shiny finish with soft contrast.",
    "Glossy": "Shiny, polished surfaces and highlights.",
    "Faded blacks": "Darks lifted to grey, for a soft, vintage look.",
    "Cross-processed": "Odd, punchy colour shifts from a film-processing trick.",
    "High contrast": "Deep darks and bright lights, punchy and bold.",
    "Soft pastel grade": "Gentle, washed-out pastel colours.",
    // Materials
    "Ceramic": "Smooth, hard, porcelain-like surfaces.",
    "Specular highlights": "Bright, sharp shine spots where light hits glossy surfaces.",
    "Leather": "Leather clothing or gear, with its sheen and texture.",
    "Silk": "Smooth, flowing fabric with a soft sheen.",
    "Velvet": "Plush, light-absorbing fabric with soft highlights.",
    "Brushed metal": "Metal with fine lines and a satin sheen.",
    "Wet skin": "Damp, glistening skin, as if from rain or sweat.",
    "Wool knit": "Chunky, cosy knitted texture.",
    "Lace": "Delicate patterned openwork fabric.",
    "Worn denim": "Faded, lived-in denim.",
    // Palette
    "White": "White as a main colour.",
    "Black": "Black as a main colour.",
    "Pastel purple": "Soft lilac and lavender tones.",
    "Teal & orange": "Classic film colour grade: teal shadows, warm orange skin.",
    "Amber & slate": "Warm amber against cool grey-blue.",
    "Neon pink & cyan": "Electric pink and cyan, a cyberpunk staple.",
    "Earth tones": "Browns, ochres and olive greens.",
    "Jewel tones": "Rich emerald, sapphire, ruby and amethyst.",
    "Monochrome": "A single colour, or black and white.",
    "Crimson & gold": "Deep red with gold accents: regal or sinister.",
    "Sage & cream": "Soft muted green with warm off-white.",
    // Background
    "From the subject": "Use the setting from the idea or card.",
    "Brutalist city": "Massive raw-concrete architecture.",
    "Neon street": "City street at night, lit by neon signs.",
    "Studio seamless": "Plain, smooth studio backdrop with no visible floor line.",
    "Forest": "Woods and trees.",
    "Interior": "Inside a room or building.",
    "Skyline at dusk": "City skyline against an evening sky.",
    "Ruins": "Crumbling ancient or abandoned buildings.",
    "Abstract gradient": "A smooth blend of colour, no real place.",
    "Plain backdrop": "A simple, single-colour background.",
    // Mood
    "Bright & cheerful": "Upbeat, sunny and light.",
    "Dark & gothic": "Brooding, shadowy and ornate.",
    "Somber": "Quiet, serious and sad.",
    "Romantic & soft": "Tender, warm and dreamy.",
    "Energetic": "Dynamic, full of movement and life.",
    "Mysterious": "Secretive and intriguing, with things half-hidden.",
    "Seductive": "Alluring and sensual.",
    "Epic & heroic": "Grand, powerful and larger than life.",
    "Dreamy": "Soft, hazy and otherworldly.",
    "Gritty": "Raw, rough and realistic.",
    "Cosy & warm": "Comfortable, homely and inviting.",
    "Tense": "On edge, with something about to happen.",
  };

  const GROUPS = SECTIONS.flatMap(s => s.groups.map(g => ({ ...g, section: s })));
  const GROUP_BY_KEY = Object.fromEntries(GROUPS.map(g => [g.key, g]));

  // Built-in looks: a starting point each, all still editable. The old Style
  // Presets reach the builder separately (see builtInLooks in prompt-builder.js)
  // so nothing they did is lost.
  const STARTER_LOOKS = [
    { id: "builtin:analog-cyberpunk", name: "Analog cyberpunk photo", picks: {
      medium: ["Analog film photo"], framing: ["Waist-up"], angle: ["Eye level"], composition: ["Symmetrical frontal"],
      lighting: ["Creamy soft key", "Soft rim light", "Volumetric haze"], lens: ["50mm"], focus: ["Extreme bokeh", "Foreground blur"],
      finish: ["Fine film grain", "Halation", "Chromatic aberration", "Slight overexposure", "Matte"],
      materials: ["Ceramic", "Specular highlights"], background: ["Brutalist city"] } },
    { id: "builtin:manhwa-cover", name: "2.5D manhwa cover", picks: {
      medium: ["Manhwa cover art"], framing: ["Waist-up"], angle: ["Three-quarter view"],
      lighting: ["Soft rim light", "Golden hour"], finish: ["Glossy"] } },
    { id: "builtin:dark-fantasy-oil", name: "Dark fantasy oil", picks: {
      medium: ["Oil painting"], framing: ["Head & shoulders"], lighting: ["Candlelight", "Chiaroscuro"],
      finish: ["Faded blacks"], palette: ["Earth tones"], mood: ["Dark & gothic"] } },
    { id: "builtin:studio-portrait", name: "Clean studio portrait", picks: {
      medium: ["Studio portrait photo"], framing: ["Head & shoulders"], angle: ["Eye level"], lighting: ["Studio softbox"],
      lens: ["85mm portrait"], focus: ["Shallow depth of field"], background: ["Plain backdrop"] } },

    // ── From the user's own cards (2026-10-18) ──
    // Each one reads the style of that card's portrait: medium, light, palette,
    // finish and setting, never the character (the card supplies who). Pose
    // and expression are left to the AI. Skipped as near-duplicates: Avril
    // Downing (= Analog cyberpunk photo), Adaeze Okonkwo (= Lumi), Sigrid
    // Vinter (merged with Phan Thị Kiều).
    { id: "builtin:card-sandra", group: "cards", name: "Sunlit lifestyle photo (Sandra McIntyre)", picks: {
      medium: ["Digital photo"], lighting: ["Golden hour", "Backlit"], lens: ["35mm"], focus: ["Shallow depth of field"],
      finish: ["Slight overexposure"], palette: ["warm cream and honey tones"], background: ["sunlit modern apartment"], mood: ["Cosy & warm"] },
      extra: "candid lifestyle photography, natural window light, relaxed at-home realism" },
    { id: "builtin:card-angharad", group: "cards", name: "Low-key gothic mist (Angharad Bowen)", picks: {
      medium: ["2.5D semi-realistic anime"], framing: ["Three-quarter length"], lighting: ["Chiaroscuro", "Soft rim light"],
      finish: ["High contrast", "Matte"], materials: ["Lace", "Velvet"], palette: ["Black", "cold silver-grey"],
      background: ["misty dark forest at night"], mood: ["Dark & gothic"] },
      extra: "low-key near-black frame lit by cold moonlight, drifting mist, delicate fine detail" },
    { id: "builtin:card-greer", group: "cards", name: "Tropical glossy 2.5D (Greer Mundy)", picks: {
      medium: ["2.5D semi-realistic anime"], framing: ["Full body"], angle: ["Low angle"], composition: ["Centred"],
      lighting: ["Hard midday sun"], finish: ["Glossy", "High contrast"], materials: ["Specular highlights"],
      palette: ["saturated tropical greens and blues"], background: ["tropical beach with palm trees"], mood: ["Bright & cheerful"] },
      extra: "vivid saturated colour, crisp shadows, glossy highlights on skin" },
    { id: "builtin:card-michelle", group: "cards", name: "Neon cyber 2.5D (Michelle Darr)", picks: {
      medium: ["2.5D semi-realistic anime"], framing: ["Full body"], angle: ["Eye level"], composition: ["Symmetrical frontal"],
      lighting: ["Neon", "Soft rim light"], finish: ["Glossy", "High contrast"], materials: ["Ceramic", "Specular highlights"],
      palette: ["electric blue and red"], background: ["high-tech lab with holographic screens and cables"] },
      extra: "wet reflective floor, glowing interface panels, sleek bodysuit sheen" },
    { id: "builtin:card-catriona", group: "cards", name: "Candlelit boudoir realism (Catriona MacLeod)", picks: {
      medium: ["Cinematic film still"], framing: ["Three-quarter length"], lighting: ["Candlelight", "Chiaroscuro"],
      lens: ["85mm portrait"], focus: ["Shallow depth of field"], finish: ["Fine film grain", "Matte"],
      materials: ["sheer linen"], palette: ["Earth tones"], background: ["candlelit old stone room"], mood: ["Romantic & soft"] },
      extra: "warm amber glow, soft painterly realism, dusty intimate atmosphere" },
    { id: "builtin:card-stephanie", group: "cards", name: "Soft high-key photo (Stephanie Engler)", picks: {
      medium: ["Digital photo"], framing: ["Full body"], angle: ["Eye level"], composition: ["Centred"],
      lighting: ["Overcast daylight", "Creamy soft key"], lens: ["50mm"], finish: ["Slight overexposure", "Soft pastel grade"],
      palette: ["White", "soft pastels"], background: ["white bedroom with white sheets and a pale wall"], mood: ["Romantic & soft"] },
      extra: "bright high-key image, airy and clean, minimal props" },
    { id: "builtin:card-moxie", group: "cards", name: "Carnival latex glamour (Moxie Crimson)", picks: {
      medium: ["Digital photo"], framing: ["Three-quarter length"], lighting: ["Golden hour", "Soft rim light"],
      lens: ["85mm portrait"], focus: ["Extreme bokeh"], finish: ["Glossy"], materials: ["latex", "Specular highlights"],
      palette: ["Crimson & gold"], background: ["vintage fairground with a carousel"], mood: ["Energetic"] },
      extra: "retro pin-up glamour photography, saturated warm colour, shiny latex" },
    { id: "builtin:card-vivienne", group: "cards", name: "Bioluminescent ethereal (Vivienne Fisher)", picks: {
      medium: ["Digital painting"], framing: ["Waist-up"], angle: ["Three-quarter view"], lighting: ["Backlit", "Volumetric haze"],
      finish: ["Glossy", "Soft pastel grade"], materials: ["translucent iridescent skin", "bioluminescent filaments"],
      palette: ["Pastel purple", "magenta and cyan glow"], background: ["cosmic nebula haze"], mood: ["Dreamy"] },
      extra: "otherworldly alien beauty, glowing translucent textures, drifting sparkles" },
    { id: "builtin:card-tzila", group: "cards", name: "Neon rim-lit anime (Tzila Mizrahi)", picks: {
      medium: ["Anime illustration"], framing: ["Three-quarter length"], lighting: ["Neon", "Soft rim light"],
      finish: ["High contrast"], palette: ["Black", "neon green and electric blue"], background: ["pure black void"], mood: ["Mysterious"] },
      extra: "glowing neon outlines tracing hair and clothing against a black background, goth streetwear" },
    { id: "builtin:card-jocosa", group: "cards", name: "Pastoral anime (Jocosa Pettifer)", picks: {
      medium: ["Anime illustration"], framing: ["Full body"], angle: ["Eye level"], composition: ["Rule of thirds"],
      lighting: ["Overcast daylight"], finish: ["Soft pastel grade", "Matte"], palette: ["Sage & cream"],
      background: ["rolling meadow with wildflowers and distant hills"], mood: ["Bright & cheerful"] },
      extra: "painterly Ghibli-like landscape, soft cel shading, a gentle breeze" },
    { id: "builtin:card-lumi", group: "cards", name: "Glossy anime pin-up (Lumi Dlamini)", picks: {
      medium: ["Anime illustration"], framing: ["Three-quarter length"], lighting: ["Creamy soft key", "Soft rim light"],
      finish: ["Glossy", "High contrast"], materials: ["Specular highlights", "latex"], mood: ["Seductive"] },
      extra: "high-gloss anime render, wet-look shine on skin and clothes, bold clean line art, detailed eyes" },
    { id: "builtin:card-eirene", group: "cards", name: "Gothic cathedral painting (Eirene Katsaros)", picks: {
      medium: ["Digital painting"], framing: ["Full body"], angle: ["Low angle"], lighting: ["Chiaroscuro", "Backlit"],
      finish: ["High contrast"], materials: ["Leather"], palette: ["deep blue and crimson"],
      background: ["gothic cathedral with stained-glass windows"], mood: ["Dark & gothic"] },
      extra: "textured painterly dark fantasy, stained-glass glow, cinematic scale" },
    { id: "builtin:card-lithia", group: "cards", name: "Crimson gothic anime (Lithia)", picks: {
      medium: ["Anime illustration"], framing: ["Waist-up"], lighting: ["Backlit", "Soft rim light"], finish: ["High contrast"],
      materials: ["Leather", "chains and buckles"], palette: ["Black", "blood red"], background: ["city street at night under red lamplight"] },
      extra: "detailed anime illustration, gothic punk styling with chains, belts and red accents" },
    { id: "builtin:card-phan-sigrid", group: "cards", name: "Monochrome, magenta accent (Phan Thị Kiều / Sigrid Vinter)", picks: {
      medium: ["3D render"], framing: ["Three-quarter length"], lighting: ["Volumetric haze", "Soft rim light"],
      finish: ["High contrast", "Matte"], materials: ["ornate engraved armour"], palette: ["Monochrome", "a single neon magenta accent"],
      background: ["misty out-of-focus city lights"], mood: ["Mysterious"] },
      extra: "silver-grey black-and-white image; the magenta is one small glowing accent only (eyes, a gem or a blade edge), never a wash over the scene; intricate dark fantasy detail" },
    { id: "builtin:card-nane", group: "cards", name: "Biomechanical render (Nane Petrosyan)", picks: {
      medium: ["3D render"], framing: ["Full body"], angle: ["Low angle"], lighting: ["Soft rim light", "Volumetric haze"],
      finish: ["Glossy", "High contrast"], materials: ["Brushed metal", "biomechanical ribbed plating", "glowing cores"],
      palette: ["Teal & orange"], background: ["dark industrial factory"] },
      extra: "Giger-inspired biomechanical anatomy fused with sleek armour, hyper-detailed metal" },
    { id: "builtin:card-liao", group: "cards", name: "Crimson night portrait (Liao Wěixīn)", picks: {
      medium: ["Digital photo"], framing: ["Three-quarter length"], lighting: ["Neon", "Backlit"], lens: ["85mm portrait"],
      focus: ["Extreme bokeh"], finish: ["High contrast", "Fine film grain"], palette: ["crimson and black"],
      background: ["city lights at night"], mood: ["Mysterious"] },
      extra: "red light carving the figure out of black, glowing night bokeh, moody fashion editorial" },
    // Tuned after a test render: soft key and a plain backdrop came out as a
    // flat, friendly photo; the original's power is contrast and the stare.
    { id: "builtin:card-tzipporah", group: "cards", name: "Ritual detail close-up (Tzipporah bat Azriel)", picks: {
      medium: ["Digital painting"], framing: ["Close-up"], angle: ["Eye level"], composition: ["Symmetrical frontal"],
      expression: ["Intense stare"], lighting: ["Chiaroscuro", "Soft rim light"], finish: ["High contrast"],
      materials: ["intricate face tattoos and runes", "silver jewellery and gemstones"],
      palette: ["desaturated silver with crimson accents"], background: ["dark smoky backdrop"], mood: ["Dark & gothic"] },
      extra: "hyperreal dark-fantasy digital art, hyper-detailed macro texture on skin, ink, metal and hair, piercing pale eyes, every surface intricate" },
    { id: "builtin:card-kurokawa", group: "cards", name: "Ink & red editorial (Kurokawa Rin)", picks: {
      medium: ["Studio portrait photo"], framing: ["Waist-up"], angle: ["Three-quarter view"], composition: ["Negative space"],
      lighting: ["Studio softbox"], lens: ["85mm portrait"], finish: ["High contrast"],
      materials: ["traditional irezumi tattoos", "red silk rope"], palette: ["Black", "White", "a single red accent"],
      background: ["white backdrop with black Japanese ink calligraphy"] },
      extra: "high-key fashion editorial, stark black and white with one bold red accent, sumi-e ink brushwork" },
  ];

  function emptyLook(name = "") {
    return { name, picks: {}, extra: "", fromImage: "" };
  }

  // Tolerates anything: a stored look from an older build, a half-filled
  // object, or a JSON string. Unknown group keys and options are kept — a
  // custom chip is just an option the catalogue doesn't list.
  function normalise(look) {
    if (typeof look === "string") {
      try { look = look ? JSON.parse(look) : null; } catch { look = null; }
    }
    if (!look || typeof look !== "object") return null;
    const picks = {};
    for (const [key, vals] of Object.entries(look.picks || {})) {
      const list = (Array.isArray(vals) ? vals : [vals]).map(v => String(v).trim()).filter(Boolean);
      if (list.length) picks[key] = [...new Set(list)];
    }
    return {
      name: String(look.name || ""),
      picks,
      extra: String(look.extra || "").trim(),
      fromImage: String(look.fromImage || "").trim(),
    };
  }

  function isEmpty(look) {
    const l = normalise(look);
    return !l || (!Object.keys(l.picks).length && !l.extra && !l.fromImage);
  }

  function countPicks(look) {
    const l = normalise(look);
    return l ? Object.values(l.picks).reduce((n, v) => n + v.length, 0) : 0;
  }

  // Lens & focus only make sense for photographs; with any other medium the
  // builder hides them and the writer ignores them.
  function isPhotoMedium(look) {
    const medium = normalise(look)?.picks.medium?.[0];
    return !medium || /photo|film still/i.test(medium);
  }

  // [{ label, values }] for every group with picks, in catalogue order, then
  // any keys the catalogue doesn't know.
  function chosenLines(look) {
    const l = normalise(look);
    if (!l) return [];
    const photo = isPhotoMedium(l);
    const lines = [];
    for (const g of GROUPS) {
      if (g.section.photoOnly && !photo) continue;
      if (l.picks[g.key]?.length) lines.push({ key: g.key, label: g.label, values: l.picks[g.key] });
    }
    for (const [key, values] of Object.entries(l.picks)) {
      if (!GROUP_BY_KEY[key]) lines.push({ key, label: key, values });
    }
    return lines;
  }

  // Labels of the groups left to the AI.
  function openGroups(look) {
    const l = normalise(look) || emptyLook();
    const photo = isPhotoMedium(l);
    return GROUPS.filter(g => !(g.section.photoOnly && !photo) && !l.picks[g.key]?.length).map(g => g.label);
  }

  function summary(look, max = 4) {
    const lines = chosenLines(look);
    if (!lines.length) return "AI decides everything";
    const vals = lines.flatMap(l => l.values);
    return vals.slice(0, max).join(", ") + (vals.length > max ? ` +${vals.length - max}` : "");
  }

  window.PromptLook = {
    SECTIONS, GROUPS, GROUP_BY_KEY, STARTER_LOOKS, DESCRIPTIONS,
    emptyLook, normalise, isEmpty, countPicks, isPhotoMedium, chosenLines, openGroups, summary,
  };
})();
