// Image generation and prompt building methods — extends APIHandler via prototype
Object.assign(APIHandler.prototype, {

  async generateImage(
    characterDescription,
    characterName,
    customPrompt = null,
    modelOverride = null,
  ) {
    let imagePrompt;
    if (customPrompt) {
      imagePrompt = await this.truncateImagePrompt(customPrompt);
    } else {
      console.log("=== GENERATING IMAGE PROMPT VIA TEXT API ===");
      console.log("Character name:", characterName);
      console.log("Character description length:", characterDescription?.length || 0);
      try {
        imagePrompt = await this.generateImagePrompt(characterDescription, characterName);
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

    // Bookend with style tags (prefix + suffix)
    let finalApiPrompt = imagePrompt;
    const style = this.config.get("api.image.style");
    if (style) {
      const { prefix, suffix } = this.getImageStyleTags(style);
      if (prefix) finalApiPrompt = `${prefix} ${finalApiPrompt.trim()}`;
      if (suffix) finalApiPrompt = `${finalApiPrompt.trim()}, ${suffix}`;
    }

    const model = modelOverride || this.config.get("api.image.model");

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
    };

    const imageSize = this.config.get("api.image.size");
    if (imageSize && imageSize.trim() !== "") data.size = imageSize.trim();

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

  async generateImagePrompt(characterDescription, characterName) {
    if (!characterDescription || !characterName) {
      throw new Error("Character description and name are required to generate an image prompt");
    }

    const metaPrompt = this.buildImagePromptInstruction(characterDescription, characterName);
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

    return await this.truncateImagePrompt(generatedPrompt.trim());
  },

  async truncateImagePrompt(prompt) {
    const MAX_LENGTH = 1000;
    if (prompt.length <= MAX_LENGTH) return prompt;

    console.log(`🔧 Image prompt too long (${prompt.length} chars). Using AI to shorten to ${MAX_LENGTH} chars...`);

    const model = this.config.get("api.text.model");
    const data = {
      model: model,
      messages: [
        {
          role: "user",
          content: `The following image generation prompt is too long. Shorten it to under 600 characters while keeping all the specific visual details: physical appearance, outfit, expression, and setting. Remove only filler words and redundancy. Do NOT add explanations, just output the shortened prompt directly.

Original prompt:
${prompt}

Shortened prompt:`,
        },
      ],
      max_tokens: 8192,
      temperature: 0.3,
      stream: true,
    };

    try {
      const response = await this.makeRequest("/api/text/chat/completions", data, false, true);
      const shortenedPrompt = await this.handleStreamResponse(response, () => {});
      const finalPrompt = shortenedPrompt.trim();
      console.log(`✅ Shortened prompt to ${finalPrompt.length} characters`);

      if (!finalPrompt || finalPrompt.length === 0) {
        console.warn("⚠️ AI returned empty shortened prompt, using fallback truncation");
        return prompt.substring(0, MAX_LENGTH - 3) + "...";
      }
      if (finalPrompt.length > MAX_LENGTH) {
        console.warn("⚠️ AI shortened prompt still too long, applying final truncation");
        return finalPrompt.substring(0, MAX_LENGTH - 3) + "...";
      }
      return finalPrompt;
    } catch (error) {
      console.error("❌ AI shortening failed, falling back to mechanical truncation:", error);
      return prompt.substring(0, MAX_LENGTH - 3) + "...";
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

  buildImagePromptInstruction(characterDescription, characterName) {
    const personalityTraits = this.extractPersonalityTraits(characterDescription);

    return `You are an expert at extracting visual details from character profiles to write image generation prompts.

Character Name: ${characterName || "Unknown"}
Personality Traits Detected: ${personalityTraits}

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
- End with 3-5 comma-separated quality tags suited to the character's tone (e.g. "cinematic lighting, highly detailed, dramatic shadows" for a noir character; "soft natural light, painterly" for a gentle one)
- Total output: 150-400 words
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
      case "realistic":
        return s("A hyper-realistic photograph of", "DSLR photo, 85mm portrait lens, natural lighting, shallow depth of field, 8k resolution, photorealistic, highly detailed skin and features, masterpiece");
      case "anime":
        return s("High quality anime illustration of", "anime style, vibrant colors, clean line art, detailed anime character design, professional anime art, 2D animation quality");
      case "hand-drawn-anime":
        return s("Traditional hand-drawn anime artwork of", "hand-drawn anime, intricate ink line art, cel shading, classic 90s anime aesthetic, paper texture, authentic traditional media, not CGI, masterpiece illustration");
      case "painted-anime":
        return s("Painted anime artwork of", "painted anime, rich canvas texture, expressive brushstrokes, traditional oil painting technique, vibrant colors, masterpiece illustration, not computer generated");
      case "waifu":
        return s("Beautiful waifu anime illustration of", "waifu style, best quality, ultra-detailed, masterpiece, beautiful anime character, soft lighting, distinct anime features, appealing design");
      case "sexy":
        return s("A seductive, alluring portrait of", "sexy, alluring, highly attractive, beautiful, masterpiece, highly detailed, stunning, tastefully posed, professional lighting");
      case "comic":
        return s("Western comic book art of", "comic book style, graphic novel, bold ink outlines, halftone shading, dynamic composition, vibrant comic colors, professional illustration");
      case "cinematic":
        return s("A cinematic film still of", "cinematic photography, anamorphic lens, dramatic chiaroscuro lighting, volumetric light, movie still, epic composition, 35mm film, color graded, photorealistic");
      case "fantasy":
        return s("Epic digital fantasy art of", "fantasy digital painting, artstation masterpiece, stylized illustration, detailed fantasy art, Greg Rutkowski style, epic atmosphere");
      case "cyberpunk":
        return s("Cyberpunk digital art of", "cyberpunk aesthetic, neon-lit rain-soaked streets, dark futuristic dystopia, holographic signage, synthwave color palette, high tech low life, highly detailed");
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
      case "gothic":
        return s("Dark gothic illustration of", "gothic art, dark fantasy, dramatic shadows, moody atmosphere, Victorian gothic aesthetic, intricate dark detail, haunting beauty");
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
        return s("Vintage retro illustration of", "vintage illustration, retro poster art, mid-century modern design, muted aged color palette, Art Deco influences, halftone texture, 1950s magazine illustration style");
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

});
