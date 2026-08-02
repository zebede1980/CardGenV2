// Image generation and prompt building methods — extends APIHandler via prototype
Object.assign(APIHandler.prototype, {

  async generateImage(
    characterDescription,
    characterName,
    customPrompt = null,
    modelOverride = null,
    cardType = "single",
    styleOverride = undefined,
    guidance = "",
    moodOverride = undefined
  ) {
    const model = modelOverride || this.config.get("api.image.model");
    const modelSettings = this.config.get("api.image.modelSettings") || {};
    const settings = modelSettings[model] || {};
    const promptLengthPref = settings.promptLengthPref || "detailed";

    let imagePrompt;
    if (customPrompt) {
      imagePrompt = promptLengthPref === "short" ? await this.truncateImagePrompt(customPrompt) : customPrompt.trim();
    } else {
      console.log("=== GENERATING IMAGE PROMPT VIA TEXT API ===");
      console.log("Character name:", characterName);
      console.log("Character description length:", characterDescription?.length || 0);
      if (guidance) console.log("Guidance:", guidance);
      try {
        imagePrompt = await this.generateImagePrompt(characterDescription, characterName, cardType, guidance, styleOverride, moodOverride);
      } catch (error) {
        console.error("Failed to generate image prompt:", error);
        throw new Error(`Failed to generate image prompt: ${error.message}`);
      }
    }

    if (!imagePrompt || typeof imagePrompt !== "string" || imagePrompt.trim().length === 0) {
      console.error("=== IMAGE PROMPT VALIDATION FAILED ===");
      throw new Error(
        "Image prompt is empty or invalid. Cannot generate image without a prompt. " +
          "This usually means the text API failed to generate a prompt description.",
      );
    }

    this.lastGeneratedImagePrompt = imagePrompt;

    // We previously stopped bookending with style tags, but to strongly enforce styles
    // and moods, we are explicitly re-introducing them under the hood before sending to the API.
    let finalApiPrompt = imagePrompt;

    const activeStyle = styleOverride !== undefined ? styleOverride : this.config.get("api.image.style");
    const activeMood = moodOverride !== undefined ? moodOverride : this.config.get("api.image.mood");

    if (activeStyle && activeStyle !== "custom") {
      const styleTags = this.getImageStyleTags(activeStyle);
      if (styleTags && (styleTags.prefix || styleTags.suffix)) {
        finalApiPrompt = `${styleTags.prefix ? styleTags.prefix + " " : ""}${finalApiPrompt}${styleTags.suffix ? ", " + styleTags.suffix : ""}`;
      }
    } else if (activeStyle === "custom") {
      const customStyleText = this.config.get("api.image.customStyleText");
      if (customStyleText && customStyleText.trim()) {
        finalApiPrompt = `${finalApiPrompt}, in the style of ${customStyleText.trim()}, masterpiece, best quality, highly detailed`;
      }
    }

    if (activeMood && activeMood.trim()) {
      const formattedMood = activeMood.replace(/-/g, " ");
      finalApiPrompt = `${finalApiPrompt}, ${formattedMood} mood, ${formattedMood} atmosphere, evocative lighting`;
    }

    const IMAGE_PROMPT_MAX = promptLengthPref === "short" ? 1000 : 10000;
    
    // Safety trim
    if (promptLengthPref === "short" && finalApiPrompt.length > IMAGE_PROMPT_MAX) {
      const trimmed = finalApiPrompt.substring(0, IMAGE_PROMPT_MAX);
      const lastPeriod = trimmed.lastIndexOf(".");
      const lastComma = trimmed.lastIndexOf(",");
      const cutPoint = lastPeriod > IMAGE_PROMPT_MAX * 0.7 ? lastPeriod + 1 : lastComma > IMAGE_PROMPT_MAX * 0.7 ? lastComma : IMAGE_PROMPT_MAX;
      finalApiPrompt = trimmed.substring(0, cutPoint).trim();
    }

    console.log("=== SENDING TO IMAGE API ===");
    console.log("Using image model:", model);
    console.log("Using custom prompt:", !!customPrompt);
    console.log("Image prompt length:", finalApiPrompt.length);
    console.log("Full image prompt being sent:");
    console.log(finalApiPrompt);
    console.log("=== END PROMPT ===");

    const data = {
      model: model,
      prompt: finalApiPrompt,
      n: 1,
      response_format: "url",
      seed: Math.floor(Math.random() * 2147483647),
    };

    const imageSize = this.config.get("api.image.size");
    const imageAspectRatio = this.config.get("api.image.aspectRatio");
    const imageSteps = settings.steps;
    const imageCfgScale = settings.cfgScale;

    if (imageAspectRatio && imageAspectRatio.trim() !== "") {
      const ratio = imageAspectRatio.trim();
      data.aspect_ratio = ratio;
      
      // Provide explicit width, height, and size for compatibility with NanoGPT / OpenRouter Flux models
      const ratioMap = {
        "1:1": { width: 1024, height: 1024 },
        "9:16": { width: 768, height: 1344 },
        "16:9": { width: 1344, height: 768 },
        "3:4": { width: 896, height: 1152 },
        "4:3": { width: 1152, height: 896 }
      };
      const dims = ratioMap[ratio];
      if (dims) {
        data.width = dims.width;
        data.height = dims.height;
        data.size = `${dims.width}x${dims.height}`;
      }
    } else if (imageSize && imageSize.trim() !== "") {
      data.size = imageSize.trim();
    }
    
    if (imageSteps && !isNaN(parseInt(imageSteps))) {
      data.steps = parseInt(imageSteps);
    }
    if (imageCfgScale && !isNaN(parseFloat(imageCfgScale))) {
      data.cfg_scale = parseFloat(imageCfgScale);
    }

    const response = await this.makeRequest("/api/image/generations", data, true);

    if (!response.ok) {
      const errorText = await response.text();
      console.error("Image API error response:", errorText);
      let errorData;
      try { errorData = JSON.parse(errorText); } catch (e) {
        throw new Error(`Image API Error (${response.status}): ${errorText}`);
      }
      const errorMessage = errorData.error?.message || errorData.message || errorData.error || "Unknown error";
      throw new Error(`Image API Error (${response.status}): ${errorMessage}`);
    }

    const result = await response.json();

    if (result.error) {
      console.error("Image API returned error object:", result.error);
      throw new Error(`Image API Error: ${result.error.message || result.error.details || result.error}`);
    }

    if (result.data && result.data.length > 0) return result.data[0].url;
    if (result.image) return result.image;
    if (result.url) return result.url;

    console.error("Unexpected image API response format. Full response:", result);
    throw new Error("Unexpected image API response format: " + JSON.stringify(result));
  },

  async generateImagePrompt(characterDescription, characterName, cardType = "single", guidance = "", styleOverride = undefined, moodOverride = undefined) {
    if (!characterDescription || !characterName) {
      throw new Error("Character description and name are required to generate an image prompt");
    }

    const style = styleOverride !== undefined ? styleOverride : this.config.get("api.image.style");
    const mood = moodOverride !== undefined ? moodOverride : this.config.get("api.image.mood");
    const imageModel = this.config.get("api.image.model");
    const modelSettings = this.config.get("api.image.modelSettings") || {};
    const settings = modelSettings[imageModel] || {};
    const lengthPref = settings.promptLengthPref || "detailed";
    const isFlux = settings.isFlux || false;
    
    const metaPrompt = this.buildImagePromptInstruction(characterDescription, characterName, cardType, guidance, style, lengthPref, mood, isFlux);
    const model = this.config.get("api.text.model");

    const data = {
      model: model,
      messages: [{ role: "user", content: metaPrompt }],
      max_tokens: 8192,
      temperature: 0.7,
      stream: true,
    };

    let response;
    try {
      response = await this.makeRequest("/api/text/chat/completions", data, false, true);
    } catch (error) {
      console.error("Text API request failed:", error);
      throw new Error(`Failed to call text API for image prompt generation: ${error.message}`);
    }

    const generatedPrompt = await this.handleStreamResponse(response, () => {});

    if (!generatedPrompt || generatedPrompt.trim().length === 0) {
      console.error("Text API returned empty prompt");
      throw new Error("Text API returned an empty image prompt");
    }

    if (lengthPref === "short") {
      return await this.truncateImagePrompt(generatedPrompt.trim());
    }

    return generatedPrompt.trim();
  },

  async truncateImagePrompt(prompt) {
    const MAX_LENGTH = 1000;
    // Target 800 chars so that style tags (~200 chars) still fit within the 1000 total limit
    const AI_TARGET = 800;

    if (prompt.length <= MAX_LENGTH) return prompt;

    console.log(`🔧 Image prompt too long (${prompt.length} chars). Using AI to shorten to ${AI_TARGET} chars...`);

    const buildShortenRequest = (target, text) => ({
      model: this.config.get("api.text.model"),
      messages: [
        {
          role: "user",
          content: `Rewrite the following image generation prompt so it is under ${target} characters total. Preserve the most visually important details: subject, physical appearance, outfit, expression, and setting. Cut filler words, repetition, and anything non-visual. Output ONLY the rewritten prompt — no explanation, no preamble, no labels.\n\nOriginal prompt:\n${text}\n\nRewritten prompt (under ${target} characters):`,
        },
      ],
      // Give enough tokens so the AI can gracefully finish the sentence without a hard cutoff
      max_tokens: 500,
      temperature: 0.2,
      stream: false,
    });

    const tryShorten = async (target, text) => {
      const result = await this.makeRequest("/api/text/chat/completions", buildShortenRequest(target, text), false, false);
      return this.processNormalResponse(result).trim();
    };

    try {
      // First pass: target AI_TARGET chars
      let shortened = await tryShorten(AI_TARGET, prompt);
      console.log(`🔍 First pass: ${shortened.length} chars`);

      if (!shortened || shortened.length === 0) {
        console.warn("⚠️ AI returned empty prompt on first pass, trying fallback truncation");
        return prompt.substring(0, MAX_LENGTH).trim();
      }

      if (shortened.length <= MAX_LENGTH) {
        console.log(`✅ Shortened successfully to ${shortened.length} chars`);
        return shortened;
      }

      // Second pass: still too long — retry with a tighter target and the already-shortened text
      console.warn(`⚠️ First pass still ${shortened.length} chars. Retrying with stricter target...`);
      const strictTarget = Math.floor(MAX_LENGTH * 0.75); // 750 chars
      let retry = await tryShorten(strictTarget, shortened);
      console.log(`🔍 Second pass: ${retry.length} chars`);

      if (retry && retry.length > 0 && retry.length <= MAX_LENGTH) {
        console.log(`✅ Shortened on second pass to ${retry.length} chars`);
        return retry;
      }

      // Last resort: trim at a sentence boundary to avoid mid-word cuts
      console.warn(`⚠️ AI still over limit after two passes (${retry?.length ?? "?"}). Trimming at sentence boundary.`);
      const candidate = (retry && retry.length > 0) ? retry : shortened;
      const trimmed = candidate.substring(0, MAX_LENGTH);
      const lastPeriod = trimmed.lastIndexOf(".");
      const lastComma = trimmed.lastIndexOf(",");
      const cutPoint = lastPeriod > MAX_LENGTH * 0.6
        ? lastPeriod + 1
        : lastComma > MAX_LENGTH * 0.6
          ? lastComma
          : MAX_LENGTH;
      return trimmed.substring(0, cutPoint).trim();

    } catch (error) {
      console.error("❌ AI shortening failed, falling back to sentence-boundary truncation:", error);
      const trimmed = prompt.substring(0, MAX_LENGTH);
      const lastPeriod = trimmed.lastIndexOf(".");
      const lastComma = trimmed.lastIndexOf(",");
      const cutPoint = lastPeriod > MAX_LENGTH * 0.6
        ? lastPeriod + 1
        : lastComma > MAX_LENGTH * 0.6
          ? lastComma
          : MAX_LENGTH;
      return trimmed.substring(0, cutPoint).trim();
    }
  },

  buildDirectImagePrompt(characterDescription, characterName) {
    const appearanceMatch = characterDescription.match(
      /\*\*Appearance:\*\*([\s\S]*?)(?=\*\*My Story:|\*\*How I Am|\*\*How I Operate|\n##)/i,
    );
    const appearanceText = appearanceMatch ? appearanceMatch[1].trim() : "";
    const personalityTraits = this.extractPersonalityTraits(characterDescription);

    let prompt = `A highly detailed portrait of ${characterName || "a character"}. `;

    if (appearanceText) {
      const cleanedAppearance = appearanceText
        .replace(/\*\*/g, "")
        .replace(/\n+/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      prompt += cleanedAppearance + " ";
    }

    if (personalityTraits.length > 0) {
      const moodMap = {
        sarcastic: "with a slight smirk and knowing eyes",
        stoic: "with a calm, composed expression",
        cynical: "with a skeptical, world-weary gaze",
        optimistic: "with bright, hopeful eyes and a warm smile",
        shy: "with a gentle, reserved demeanor",
        confident: "with bold, self-assured posture",
        mysterious: "with an enigmatic expression",
        friendly: "with an approachable, warm expression",
        serious: "with focused, intense eyes",
        playful: "with a mischievous glint in their eyes",
      };
      const mood = moodMap[personalityTraits[0]] || "with an expressive face";
      prompt += mood + ". ";
    }

    prompt += " Appropriate background that suits the character's setting and personality.";
    return prompt;
  },

  buildImagePromptInstruction(characterDescription, characterName, cardType = "single", guidance = "", style = "", lengthPref = "detailed", mood = "", isFlux = false) {
    const personalityTraits = this.extractPersonalityTraits(characterDescription);

    let taskInstruction = "";
    if (cardType === "group") {
      taskInstruction = `\n\nIMPORTANT: This is a GROUP card. Generate a group portrait or ensemble scene showing multiple characters together. Focus on the group dynamic — show at least two or three figures in a shared environment that reflects their collective identity. Do not focus on just one person.`;
    } else if (cardType === "scenario") {
      taskInstruction = `\n\nIMPORTANT: This is a SCENARIO / LOCATION card. Generate a scene or environment illustration — focus on the atmosphere, setting, and sense of place rather than on a single character portrait. Any figures present should feel like part of the environment, not the subject. Prioritise mood, lighting, and environmental detail.`;
    }

    let guidanceBlock = "";
    if (guidance && guidance.trim()) {
      guidanceBlock = `\n\nUSER GUIDANCE (high priority — steer the image toward these specifics):\n${guidance.trim()}\n\nIncorporate the guidance above as the primary creative direction. Override or adapt profile details as needed to satisfy the guidance.`;
    }
    
    let styleBlock = "";
    if (style === "custom") {
      const customStyleText = this.config.get("api.image.customStyleText");
      if (customStyleText && customStyleText.trim()) {
        styleBlock = `\n- STYLE DIRECTIVE (ABSOLUTE CRITICAL PRIORITY): The requested art style is "${customStyleText.trim()}". You MUST heavily bias the entire prompt towards this style. Start the prompt with words related to this style, and use medium-specific keywords.`;
      }
    } else if (style && style.trim()) {
      let styleName = style.replace(/-/g, " ");
      let mediumExamples = `"illustration", "3D render", "digital painting"`;
      
      if (style === "realistic") {
        styleName = "Realistic / Photography";
        mediumExamples = `"photograph", "DSLR photo", "cinematic photography"`;
      } else if (style === "2.5d-realistic-anime") {
        mediumExamples = `"2.5D anime render", "semi-realistic", "intricate digital shading"`;
      } else if (style.includes("anime") || style === "waifu") {
        mediumExamples = `"anime illustration", "cel shading", "2D art"`;
      } else if (style === "cinematic") {
        mediumExamples = `"cinematic film still", "movie scene", "anamorphic"`;
      } else if (style === "3d-render") {
        mediumExamples = `"3D render", "octane render", "CGI"`;
      } else if (style === "oil-painting") {
        mediumExamples = `"oil on canvas", "impasto", "classical painting"`;
      } else if (style === "watercolor") {
        mediumExamples = `"watercolor painting", "ink and wash", "translucent"`;
      } else if (style === "comic" || style === "comic-book") {
        mediumExamples = `"comic book art", "graphic novel", "ink outlines"`;
      } else if (style === "fantasy") {
        mediumExamples = `"high fantasy illustration", "mythological art", "ethereal lighting"`;
      } else if (style === "sci-fi") {
        mediumExamples = `"cyberpunk", "sci-fi concept art", "futuristic render"`;
      } else if (style === "digital-art") {
        mediumExamples = `"digital illustration", "concept art", "digital painting"`;
      }

      styleBlock = `\n- STYLE DIRECTIVE (ABSOLUTE CRITICAL PRIORITY): The requested art style is "${styleName}". You MUST heavily bias the entire prompt towards this style. Start the prompt with words related to this style, and use medium-specific keywords (e.g. ${mediumExamples}).`;
    }
    
    let moodBlock = "";
    if (mood && mood.trim()) {
      const formattedMood = mood.replace(/-/g, " ");
      moodBlock = `\n- MOOD DIRECTIVE (ABSOLUTE CRITICAL PRIORITY): The requested mood is "${formattedMood}". You MUST dictate the lighting, character expression, and environmental atmosphere to vividly convey this mood.`;
    }
    
    let lengthBlock = lengthPref === "short" 
        ? "Total output: 50-100 words. Keep it direct and concise, ideal for fast generation models."
        : "Total output: 150-300 words. Make it highly detailed and descriptive, ideal for heavyweight generation models.";

    let fluxBlock = "";
    if (isFlux) {
      fluxBlock = `\n- FLUX MODEL COMPATIBILITY (CRITICAL): Write a natural language prompt compatible with Flux. Use full, highly descriptive sentences focusing on spatial relationships, composition, and accurate anatomy. DO NOT use comma-separated Danbooru tags. DO NOT use negative prompts in the text.`;
    }

    let qualityBlock = isFlux
      ? "- QUALITY DIRECTIVE: Describe the visual quality and medium naturally within the sentences. Do not use old SD-style quality tags like \"masterpiece\" or \"best quality\", and DO NOT use comma-separated tags at the end."
      : "- ALWAYS include keywords that ensure a highly detailed and high-quality image (e.g. \"masterpiece, best quality, highly detailed, high resolution\"). You may include these as comma-separated tags at the end or weave them naturally.";

    return `You are an expert at extracting visual details from character profiles to write image generation prompts.

Character Name: ${characterName || "Unknown"}
Personality Traits Detected: ${personalityTraits}${taskInstruction}${guidanceBlock}

Full Character Profile:
${characterDescription}

Your task: Read the profile above and output a single image generation prompt.

Extract these specifics from the profile text:
- SUBJECT: name, apparent gender, approximate age range, species/ethnicity if notable
- PHYSICAL: exact hair colour and style, eye colour, any distinctive features (scars, tattoos, unusual traits)
- OUTFIT: specific clothing that matches their role, world, or status — not generic
- EXPRESSION: one expression or body language cue that reflects their dominant personality trait (e.g. "cold calculating stare", "warm crooked smile", "guarded tense posture")
- SETTING: one concrete location or environment drawn from their backstory or scenario

Format rules:
- Output ONE paragraph, no lists, no labels, no headers
- Lead with the subject and physical details, weave in expression and setting naturally
- Describe the lighting, mood, and atmosphere that fits the character's tone. To avoid flat images, ALWAYS specify dynamic lighting conditions (e.g., "volumetric lighting", "cinematic lighting", "deep dramatic shadows", "high contrast", "HDR") to ensure the image has striking depth and dimension.
${qualityBlock}
- CRITICAL AVOIDANCE: DO NOT use terms like "photograph", "real life", or "camera" UNLESS the requested style is explicitly a photograph or realistic. However, you MAY and SHOULD use lighting and depth terms (like "studio lighting" or "dramatic shadows") for any style to maintain visual depth!
- ${lengthBlock}${styleBlock}${moodBlock}${fluxBlock}
- Do NOT start with "Here is" or any preamble — begin the prompt directly

BEGIN PROMPT:`;
  },

  extractPersonalityTraits(text) {
    const traits = [];
    const t = text.toLowerCase();
    if (t.includes("sarcastic")) traits.push("sarcastic");
    if (t.includes("stoic") || t.includes("stoicism")) traits.push("stoic");
    if (t.includes("cynical")) traits.push("cynical");
    if (t.includes("optimistic") || t.includes("optimism")) traits.push("optimistic");
    if (t.includes("formal")) traits.push("formal");
    if (t.includes("vulgar") || t.includes("crass")) traits.push("rough-speaking");
    if (t.includes("quiet") || t.includes("reserved")) traits.push("reserved");
    if (t.includes("graceful")) traits.push("graceful");
    if (t.includes("clumsy")) traits.push("clumsy");
    if (t.includes("restless")) traits.push("restless");
    if (t.includes("menacing") || t.includes("intimidating")) traits.push("menacing");
    return traits.length > 0 ? traits.join(", ") : "complex personality";
  },

  getImageStyleTags(style) {
    const s = (prefix, suffix) => ({ prefix, suffix });
    switch (style) {
      case "2.5d-realistic-anime":
      case "semi-realistic":
        return s("High-quality 2.5D semi-realistic anime illustration of", "detailed digital painting, 2.5D anime aesthetic, semi-realistic anime render, modern manhwa cover art style, highly detailed features, glossy textures, cinematic dual lighting, dramatic atmosphere, masterpiece");
      case "realistic":
        return s("A hyper-realistic photograph of", "DSLR photo, 85mm portrait lens, natural lighting, shallow depth of field, 8k resolution, photorealistic, highly detailed skin and features, masterpiece");
      case "anime":
        return s("Anime illustration of", "masterpiece, best quality, anime art, vibrant colors, detailed eyes, clean line art, soft cel shading, expressive, 2D illustration");
      case "hand-drawn-anime":
        return s("Traditional hand-drawn anime artwork of", "hand-drawn anime, intricate ink line art, cel shading, classic 90s anime aesthetic, paper texture, traditional media, masterpiece illustration");
      case "painted-anime":
        return s("Painted anime artwork of", "painted anime, rich canvas texture, expressive brushstrokes, oil painting technique, vibrant colors, masterpiece illustration");
      case "waifu":
        return s("Waifu anime illustration of", "waifu style, best quality, ultra-detailed, masterpiece, soft lighting, large expressive eyes, detailed hair, appealing design");
      case "sexy":
        return s("A glamorous, alluring portrait of", "masterpiece, best quality, glamorous lighting, confident pose, elegant figure, radiant skin, cinematic composition, highly detailed");
      case "comic":
      case "comic-book":
        return s("Western comic book art of", "comic book style, graphic novel, bold ink outlines, halftone shading, dynamic composition, vibrant comic colors, professional illustration");
      case "cinematic":
        return s("A cinematic film still of", "cinematic photography, anamorphic lens, dramatic chiaroscuro lighting, volumetric light, movie still, epic composition, photorealistic, masterpiece");
      case "digital-art":
        return s("High-quality digital illustration of", "digital painting, highly detailed, concept art, trending on artstation, masterpiece, professional illustration");
      case "fantasy":
        return s("Epic digital fantasy art of", "fantasy digital painting, stylized illustration, detailed fantasy art, dramatic lighting, epic atmosphere, intricate costume design, masterpiece");
      case "cyberpunk":
        return s("Cyberpunk digital art of", "cyberpunk aesthetic, neon-lit rain-soaked streets, dark futuristic dystopia, holographic signage, synthwave color palette, high tech low life, highly detailed");
      case "sci-fi":
        return s("Sci-fi digital art of", "science fiction illustration, futuristic, highly detailed, dramatic lighting, high tech, digital painting, masterpiece");
      case "3d-render":
        return s("A high-quality 3D render of", "octane render, Unreal Engine 5, ray tracing, subsurface scattering, physically based rendering, studio lighting, CGI, masterpiece");
      case "watercolor":
        return s("A watercolor painting of", "watercolor illustration, wet-on-wet technique, soft diffused edges, translucent washes, pastel tones, watercolor paper texture, beautiful fine art");
      case "pixel":
        return s("Pixel art of", "pixel art, 16-bit SNES style, crisp pixels, limited color palette, retro game sprite, high quality pixel illustration");
      case "oil-painting":
        return s("A classical oil painting portrait of", "oil on canvas, old masters technique, impasto brushwork, rich saturated colors, Rembrandt lighting, museum quality fine art, highly detailed");
      case "concept-art":
        return s("Professional character concept art of", "game concept art, character design sheet, clean rendering, professional illustration, artstation, dynamic lighting, detailed costume design");
      case "grunge-anime":
        return s("Modern edgy 2D anime illustration of", "grunge aesthetic, highly desaturated color palette, sharp messy line art, detailed streetwear fashion, chaotic expressive vibe, flat cel shading, Pixiv ranking style, masterpiece");
      case "gothic-anime":
        return s("Semi-realistic anime illustration of", "dark fantasy gothic, high contrast lighting, dramatic shadows, detailed concept art, palette of deep blacks, stark whites, luminous crimson");
      case "gothic":
        return s("Dark gothic fantasy illustration of", "gothic horror, dramatic chiaroscuro lighting, deep shadows, ornate Victorian detail, cathedral motifs, haunting atmosphere, highly detailed, masterpiece");
      case "art-nouveau":
        return s("Art Nouveau illustration of", "Art Nouveau style, Alphonse Mucha inspired, flowing organic lines, decorative floral border motifs, elegant curves, muted jewel tones, vintage poster art, ornamental");
      case "noir":
        return s("Film noir black and white photograph of", "film noir, black and white photography, hard chiaroscuro lighting, deep shadows, venetian blind light streaks, 1940s aesthetic, grainy 35mm, dramatic contrast");
      case "ink-sketch":
        return s("Detailed pen and ink sketch of", "pen and ink illustration, cross-hatching, fine line art, monochrome, technical pen drawing, editorial illustration style, high contrast black and white");
      case "storybook":
        return s("Whimsical storybook illustration of", "children's book illustration, warm inviting palette, soft rounded shapes, charming storybook art, gentle painterly style, fairy tale aesthetic, detailed background");
      case "manhwa":
        return s("Korean manhwa style illustration of", "manhwa art style, webtoon, clean crisp line art, soft cel shading, expressive large eyes, detailed hair, Korean comic aesthetic, professional webtoon quality");
      case "chibi":
        return s("Cute chibi anime illustration of", "chibi style, super deformed SD, large head small body, adorable rounded features, pastel colors, clean lines, kawaii, chibi character art");
      case "vintage":
        return s("Vintage retro illustration of", "vintage illustration, 1950s magazine style, mid-century modern design, muted aged color palette, halftone texture, nostalgic Americana, retro poster art, masterpiece");
      case "prismatic-anime":
          return s("Luminescent anime illustration of","dynamic lighting, glowing lens flares, floating light particles, shattered prisms, vibrant cyan and magenta, high contrast, masterpiece");
      case "genshin":
        return s("3D cel-shaded anime illustration of", "Genshin Impact style, official game art, intricate fantasy outfit, glowing elemental magic, soft vibrant lighting, high quality 3D anime render, masterpiece");
      case "dark-graphic-novel":
        return s("Gritty graphic novel illustration of", "dark fantasy comic style, heavy inking, crosshatching shading, muted earth tones, detailed line art, dramatic shadows, masterpiece");
      case "arcane":
        return s("Arcane-style painted 3D illustration of", "Arcane League of Legends style, Fortiche Production, hand-painted 3D, rich textured brushstrokes, dramatic cinematic lighting, stylized realism, masterpiece");
      case "disney-pixar":
        return s("Disney Pixar 3D animated character of", "Pixar style, Disney animation, expressive character design, soft subsurface scattering, vibrant warm colors, charming appeal, high quality 3D render");
      case "ghibli":
        return s("Studio Ghibli anime illustration of", "Studio Ghibli style, Hayao Miyazaki, soft watercolor backgrounds, lush nature detail, gentle hand-drawn aesthetic, warm nostalgic lighting, masterpiece anime film still");
      case "90s-dark-animation":
        return s("90s dark animation style illustration of", "Batman The Animated Series style, dark deco, flat cel shading, heavy black shadows, moody atmosphere, limited color palette, noir comic animation, masterpiece");
      case "voxel":
        return s("Voxel art 3D character of", "voxel art style, blocky 3D, isometric, crisp cubes, Minecraft aesthetic, clean sharp edges, vibrant colors, game asset, high quality voxel render");
      case "propaganda-poster":
        return s("Propaganda poster illustration of", "Soviet constructivist propaganda poster, bold geometric shapes, limited palette of red black and cream, heroic pose, stencil typography, WPA era, striking graphic design");
      case "stained-glass":
        return s("Stained glass window art of", "stained glass cathedral window, luminous translucent colors, bold lead lines, mosaic fragments, sacred geometry, backlit glowing radiance, medieval gothic style, masterpiece");
      case "ukiyo-e":
        return s("Japanese ukiyo-e woodblock print of", "ukiyo-e style, Japanese woodblock print, Hokusai and Hiroshige influence, flat color planes, bold outlines, washi paper texture, Edo period aesthetic, traditional Japanese art, masterpiece");
      case "pin-up":
        return s("Classic pin-up illustration of", "pin-up art, Vargas style, 1940s cheesecake, playful boudoir glamour, airbrushed skin, vintage Americana, soft curves, retro pin-up girl, masterpiece illustration");
      case "hentai":
        return s("Ecchi hentai anime illustration of", "hentai anime style, glossy rendering, detailed curves, soft lighting, blush tones, cel shading, high quality, provocative pose, masterpiece");
      case "frazetta":
        return s("Frank Frazetta fantasy painting of", "Frazetta style, classic sword and sorcery, dramatic oil painting, dramatic chiaroscuro, powerful athletic physique, primal energy, dark fantasy, iconic 1970s fantasy art, masterpiece");
      case "manhwa-18":
        return s("Mature manhwa webtoon illustration of", "manhwa 18+ art style, glossy clean rendering, detailed anatomy, dramatic lighting, highly stylized, Korean mature webtoon aesthetic, professional quality");
      case "yaoi-bl":
        return s("Yaoi boys love anime illustration of", "yaoi BL style, elegant bishounen, delicate features, long-limbed, rose-tinted palette, soft romantic atmosphere, flowing hair, graceful pose, shounen-ai, masterpiece");
      default: return { prefix: "", suffix: "" };
    }
  },

  async describeReferenceImage(imageDataUrl, manualHint = "") {
    if (!imageDataUrl) throw new Error("Reference image is required");

    const model = this.config.get("api.text.visionModel") || this.config.get("api.text.model");
    if (!model) throw new Error("No vision model or text model configured");

    const systemPrompt =
      "You describe reference character images for roleplay card generation. Output one concise paragraph that captures visible appearance, clothing, age cues, emotion, posture, accessories, and likely setting. Do not mention uncertainty, policy, or analysis steps.";

    const userText = manualHint
      ? `Use this user hint while describing: ${manualHint}`
      : "Describe this character image for roleplay character generation.";

    const data = {
      model,
      messages: [
        { role: "system", content: systemPrompt },
        {
          role: "user",
          content: [
            { type: "text", text: userText },
            { type: "image_url", image_url: { url: imageDataUrl } },
          ],
        },
      ],
      temperature: 0.3,
      max_tokens: 500,
      stream: false,
    };

    const response = await this.makeRequest("/chat/completions", data, false, false);
    return this.processNormalResponse(response).trim();
  },

  async extractStyleFromImage(imageDataUrl) {
    if (!imageDataUrl) throw new Error("Image is required");

    const model = this.config.get("api.text.visionModel") || this.config.get("api.text.model");
    if (!model) throw new Error("No vision model or text model configured");

    const systemPrompt =
      "You are an expert art critic and prompt engineer. Analyze the provided image and output ONE concise paragraph describing ONLY its artistic style. Do NOT describe the subjects, characters, or actions in the image. Focus strictly on the medium (e.g. watercolor, digital art, 3D render, oil painting), lighting, shading technique, line art style, color palette, camera angle/framing (if relevant to style), and overall aesthetic vibe. Do not include preamble or labels.";

    const data = {
      model,
      messages: [
        { role: "system", content: systemPrompt },
        {
          role: "user",
          content: [
            { type: "text", text: "Extract the artistic style from this image." },
            { type: "image_url", image_url: { url: imageDataUrl } },
          ],
        },
      ],
      temperature: 0.3,
      max_tokens: 200,
      stream: false,
    };

    const response = await this.makeRequest("/api/text/chat/completions", data, false, false);
    return this.processNormalResponse(response).trim();
  },

  // Local image generation via WebUI Forge — called directly from the browser,
  // bypassing the proxy server (which runs in Docker and can't reach host 127.0.0.1).
  // Forge's API has CORS open by default when launched with --api.
  async generateForgeImage(prompt) {
    const forgeUrl = (this.config.get("api.image.localForge.url") || "http://127.0.0.1:7860").replace(/\/$/, "");
    const txt2imgUrl = `${forgeUrl}/sdapi/v1/txt2img`;

    // Read steps & cfg_scale from the shared Settings fields (same ones used by cloud API).
    // Default cfg_scale to 7 — safe for SDXL/SD1.5; FLUX users should set it to 1 via Settings.
    const settingsSteps   = parseInt(this.config.get("api.image.settings.steps"))   || 20;
    const settingsCfg     = parseFloat(this.config.get("api.image.settings.cfgScale")) || 1;

    // Resolve width/height from aspect ratio setting
    const aspectRatio = this.config.get("api.image.aspectRatio") || "3:4";
    const ratioMap = {
      "1:1":  { width: 1024, height: 1024 },
      "9:16": { width: 768,  height: 1344 },
      "16:9": { width: 1344, height: 768  },
      "3:4":  { width: 896,  height: 1152 },
      "4:3":  { width: 1152, height: 896  },
    };
    const dims = ratioMap[aspectRatio] || ratioMap["3:4"];

    const forgePayload = {
      prompt,
      steps:        settingsSteps,
      cfg_scale:    settingsCfg,
      width:        dims.width,
      height:       dims.height,
      sampler_name: "Euler",
      scheduler:    "Simple",
    };
    console.log("🔧 Forge payload:", JSON.stringify(forgePayload));

    let response;
    try {
      // Direct browser fetch — no proxy, so host-local Forge is reachable
      response = await fetch(txt2imgUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(forgePayload),
      });
    } catch (connErr) {
      throw new Error(
        `Cannot connect to Forge at ${forgeUrl}. ` +
        `Make sure it is running with the --api flag and that no firewall is blocking port 7860. ` +
        `(${connErr.message})`
      );
    }

    if (!response.ok) {
      let detail = response.statusText;
      try { const j = await response.json(); detail = j.detail || j.error?.message || detail; } catch (_) {}
      throw new Error(`Forge returned ${response.status}: ${detail}`);
    }

    const data = await response.json();
    const images = data.images;
    if (!images || images.length === 0) {
      throw new Error("Forge returned no images in response");
    }

    // ── DIAGNOSTIC (temporary) ──────────────────────────────────────────────
    console.group("🔧 Forge response diagnostics");
    console.log("images array length:", images.length);
    images.forEach((img, i) => {
      const preview = typeof img === "string" ? img.slice(0, 80) : img;
      console.log(`images[${i}] type=${typeof img} length=${typeof img === "string" ? img.length : "N/A"} starts-with:`, preview);
    });
    console.groupEnd();
    // ── END DIAGNOSTIC ───────────────────────────────────────────────────────

    // images[0] is a raw base64 PNG — decode it to a blob URL.
    // Forge may line-wrap the base64 string at 76 chars (RFC 2045).
    // atob() throws on any whitespace, so strip it first.
    const rawImg = images[0];
    // Handle case where Forge already prefixes with "data:..."
    if (typeof rawImg === "string" && rawImg.startsWith("data:")) {
      console.log("🔧 Forge returned a data URI directly — using as-is");
      // Create blob from it for consistency
      const res2 = await fetch(rawImg);
      const blob2 = await res2.blob();
      return URL.createObjectURL(blob2);
    }
    const cleanB64 = rawImg.replace(/\s/g, "");
    console.log("🔧 cleanB64 length:", cleanB64.length, "first 40 chars:", cleanB64.slice(0, 40));
    const byteChars = atob(cleanB64);
    const byteArray = new Uint8Array(byteChars.length);
    for (let i = 0; i < byteChars.length; i++) byteArray[i] = byteChars.charCodeAt(i);
    // Detect mime type from PNG/JPEG magic bytes
    const mimeType = (byteArray[0] === 0xFF && byteArray[1] === 0xD8) ? "image/jpeg" : "image/png";
    console.log("🔧 Binary size:", byteArray.length, "bytes | detected mime:", mimeType, "| first bytes:", byteArray[0], byteArray[1], byteArray[2], byteArray[3]);
    const blob = new Blob([byteArray], { type: mimeType });
    return URL.createObjectURL(blob);
  },

  // ── Inpainting / In-fill Methods ──────────────────────────────────────────

  // Direct Forge inpainting via /sdapi/v1/img2img
  async inpaintForgeImage({ imageBase64, maskBase64, prompt = "", denoisingStrength = 0.85, width, height }) {
    const forgeUrl = (this.config.get("api.image.localForge.url") || "http://127.0.0.1:7860").replace(/\/$/, "");
    const img2imgUrl = `${forgeUrl}/sdapi/v1/img2img`;

    const settingsSteps = parseInt(this.config.get("api.image.settings.steps")) || 20;
    const settingsCfg = parseFloat(this.config.get("api.image.settings.cfgScale")) || 1;

    // Clean base64 strings (remove data:image/...;base64, prefix if present)
    const cleanImg = imageBase64.includes(",") ? imageBase64.split(",")[1] : imageBase64;
    const cleanMask = maskBase64.includes(",") ? maskBase64.split(",")[1] : maskBase64;

    const payload = {
      init_images: [cleanImg],
      mask: cleanMask,
      prompt: prompt || "",
      negative_prompt: "text, watermark, logo, blurry, ugly, low quality, artifacts, signatures",
      inpainting_fill: 1, // 1 = original image underlying
      inpaint_full_res: true,
      inpaint_full_res_padding: 32,
      inpainting_mask_invert: 0, // 0 = inpaint masked area
      mask_blur: 4,
      denoising_strength: denoisingStrength || 0.85,
      steps: settingsSteps,
      cfg_scale: settingsCfg,
      sampler_name: "Euler",
      scheduler: "Simple",
      width: width || 896,
      height: height || 1152,
    };

    console.log("🎨 Sending Inpainting request to Forge:", img2imgUrl);

    let response;
    try {
      response = await fetch(img2imgUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    } catch (connErr) {
      throw new Error(
        `Cannot connect to Forge at ${forgeUrl}. ` +
        `Ensure Forge is running with --api flag. (${connErr.message})`
      );
    }

    if (!response.ok) {
      let detail = response.statusText;
      try { const j = await response.json(); detail = j.detail || j.error?.message || detail; } catch (_) {}
      throw new Error(`Forge inpainting returned ${response.status}: ${detail}`);
    }

    const data = await response.json();
    const images = data.images;
    if (!images || images.length === 0) {
      throw new Error("Forge returned no infilled image in response");
    }

    const rawImg = images[0];
    if (typeof rawImg === "string" && rawImg.startsWith("data:")) {
      const res2 = await fetch(rawImg);
      const blob2 = await res2.blob();
      return URL.createObjectURL(blob2);
    }

    const cleanB64 = rawImg.replace(/\s/g, "");
    const byteChars = atob(cleanB64);
    const byteArray = new Uint8Array(byteChars.length);
    for (let i = 0; i < byteChars.length; i++) byteArray[i] = byteChars.charCodeAt(i);
    const mimeType = (byteArray[0] === 0xFF && byteArray[1] === 0xD8) ? "image/jpeg" : "image/png";
    const blob = new Blob([byteArray], { type: mimeType });
    return URL.createObjectURL(blob);
  },

  // Cloud / OpenAI-compatible / Custom Inpainting API
  async inpaintCloudImage({ imageBase64, maskBase64, imageBlob, maskBlob, prompt = "", modelOverride, endpointOverride, apiKeyOverride }) {
    const infillConfig = this.config.get("api.image.infill") || {};
    const model = modelOverride || infillConfig.model || this.config.get("api.image.model") || "dall-e-2";
    const customEndpoint = endpointOverride || infillConfig.customEndpoint;
    const apiKey = apiKeyOverride || infillConfig.customApiKey || this.config.get("api.image.apiKey");
    const baseUrl = this.config.get("api.image.baseUrl");

    let imgB64 = imageBase64;
    let mskB64 = maskBase64;

    if (!imgB64 && imageBlob) {
      imgB64 = await new Promise((resolve) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result);
        reader.readAsDataURL(imageBlob);
      });
    }
    if (!mskB64 && maskBlob) {
      mskB64 = await new Promise((resolve) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result);
        reader.readAsDataURL(maskBlob);
      });
    }

    const payload = {
      image: imgB64,
      mask: mskB64,
      prompt: prompt && prompt.trim() ? prompt.trim() : "seamless continuation, clean background, remove text, natural texture",
      model: model || "dall-e-2",
      n: 1,
      response_format: "url",
    };

    // Call proxy /api/image/inpaint to prevent CORS restrictions
    const proxyUrl = "/api/image/inpaint";
    const headers = {
      "Content-Type": "application/json",
    };
    if (apiKey) headers["X-API-Key"] = apiKey;
    if (customEndpoint) headers["X-Infill-Endpoint"] = customEndpoint;
    if (baseUrl) headers["X-API-URL"] = baseUrl;

    console.log("🎨 Sending Inpainting request via proxy:", proxyUrl);

    const response = await (window.authFetch || fetch)(proxyUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      let detail = response.statusText;
      try {
        const j = await response.json();
        detail = j.error?.message || j.detail || j.message || detail;
      } catch (_) {}
      throw new Error(`Inpainting API returned ${response.status}: ${detail}`);
    }

    const contentType = response.headers.get("content-type") || "";
    if (contentType.includes("image/")) {
      const blob = await response.blob();
      return URL.createObjectURL(blob);
    }

    const data = await response.json();
    let imageUrl = data.data?.[0]?.url || data.images?.[0] || data.image || data.url;
    if (!imageUrl && data.data?.[0]?.b64_json) {
      imageUrl = `data:image/png;base64,${data.data[0].b64_json}`;
    }

    if (!imageUrl) {
      throw new Error("Inpainting API returned no image in response");
    }

    if (imageUrl.startsWith("data:") || imageUrl.startsWith("blob:")) {
      return imageUrl;
    }

    const proxyImgRes = await (window.authFetch || fetch)(`/api/proxy-image?url=${encodeURIComponent(imageUrl)}`);
    if (proxyImgRes.ok) {
      const blob = await proxyImgRes.blob();
      return URL.createObjectURL(blob);
    }

    return imageUrl;
  },

  // Main unified Infill Dispatcher
  async inpaintImage({ imageBase64, maskBase64, imageBlob, maskBlob, prompt = "", providerOverride = null, width, height }) {
    const infillConfig = this.config.get("api.image.infill") || {};
    const provider = providerOverride || infillConfig.provider || "localForge";

    console.log(`🎨 Starting Inpainting with provider: ${provider}`);

    if (provider === "localForge") {
      const denoising = infillConfig.denoisingStrength ?? 0.85;

      return await this.inpaintForgeImage({
        imageBase64,
        maskBase64,
        prompt,
        denoisingStrength: denoising,
        width,
        height
      });
    } else {
      let imgBlob = imageBlob;
      let mskBlob = maskBlob;

      if (!imgBlob && imageBase64) {
        const res = await fetch(imageBase64);
        imgBlob = await res.blob();
      }
      if (!mskBlob && maskBase64) {
        const res = await fetch(maskBase64);
        mskBlob = await res.blob();
      }

      return await this.inpaintCloudImage({
        imageBlob: imgBlob,
        maskBlob: mskBlob,
        prompt,
        modelOverride: infillConfig.model,
        endpointOverride: infillConfig.customEndpoint,
        apiKeyOverride: infillConfig.customApiKey,
      });
    }
  },

});
