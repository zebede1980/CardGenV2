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
    SECTIONS, GROUPS, GROUP_BY_KEY, STARTER_LOOKS,
    emptyLook, normalise, isEmpty, countPicks, isPhotoMedium, chosenLines, openGroups, summary,
  };
})();
