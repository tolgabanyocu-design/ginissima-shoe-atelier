/**
 * Ginissima Cloudflare Worker
 * Handles both static files AND API proxy
 */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    
    // Handle API calls to Anthropic (Claude) for validation
    if (url.pathname === '/api/anthropic') {
      return handleAnthropicRequest(request, env);
    }

    // OpenAI Image Edit API proxy (also handles Gemini via useGemini flag)
    if (url.pathname === '/api/openai-image' || url.pathname === '/api/gemini-gen') {
      return handleOpenAIImageRequest(request, env);
    }
    
    // Handle URL validation for Shopify product links
    if (url.pathname === '/api/validate-url') {
      return handleValidateUrl(url);
    }
    
    // For all other requests, serve static assets
    return env.ASSETS.fetch(request);
  },
};

async function handleValidateUrl(url) {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json',
  };

  const targetUrl = url.searchParams.get('url');
  if (!targetUrl) {
    return new Response(JSON.stringify({ valid: false, error: 'No URL provided' }), { headers: corsHeaders });
  }

  try {
    const resp = await fetch(targetUrl, { method: 'HEAD', redirect: 'follow' });
    return new Response(JSON.stringify({ valid: resp.ok, status: resp.status }), { headers: corsHeaders });
  } catch (error) {
    return new Response(JSON.stringify({ valid: false, error: error.message }), { headers: corsHeaders });
  }
}

async function handleAnthropicRequest(request, env) {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  if (request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405, headers: corsHeaders });
  }

  try {
    const apiKey = env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return new Response(
        JSON.stringify({ error: 'ANTHROPIC_API_KEY not configured. Add it in Cloudflare dashboard.' }), 
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const body = await request.json();
    
    const anthropicResponse = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: body.model || 'claude-sonnet-4-20250514',
        max_tokens: body.max_tokens || 300,
        messages: body.messages,
      }),
    });

    const data = await anthropicResponse.text();
    
    if (!anthropicResponse.ok) {
      console.log('Anthropic API error:', anthropicResponse.status, data.substring(0, 300));
    }
    
    return new Response(data, {
      status: anthropicResponse.status,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (error) {
    return new Response(
      JSON.stringify({ error: error.message }), 
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
}


async function handleOpenAIImageRequest(request, env) {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  if (request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405, headers: corsHeaders });
  }

  try {
    const body = await request.json();
    
    // Gemini mode — route through same endpoint to avoid 404 issues
    if (body.useGemini) {
      const geminiKey = env.GEMINI_API_KEY;
      if (!geminiKey) {
        return new Response(
          JSON.stringify({ error: 'GEMINI_API_KEY not configured.' }), 
          { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }
      const model = body.model || 'gemini-3-pro-image-preview';
      console.log('Gemini mode, model:', model);
      const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${geminiKey}`;
      const geminiResponse = await fetch(geminiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: body.contents,
          generationConfig: body.generationConfig,
        }),
      });
      const data = await geminiResponse.text();
      return new Response(data, {
        status: geminiResponse.status,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // OpenAI paths below — require OpenAI key
    const apiKey = env.OPENAI_API_KEY;
    if (!apiKey) {
      return new Response(
        JSON.stringify({ error: 'OPENAI_API_KEY not configured. Add it in Cloudflare dashboard.' }), 
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }
    
    // Use Responses API with image_generation tool for better conversational editing
    if (body.useResponses) {
      const input = [];
      
      // Build input content array with images and text
      const contentParts = [];
      for (const img of (body.images || [])) {
        contentParts.push({
          type: 'input_image',
          image_url: `data:${img.mime || 'image/jpeg'};base64,${img.b64}`
        });
      }
      contentParts.push({ type: 'input_text', text: body.prompt });
      
      input.push({ role: 'user', content: contentParts });
      
      const responsesBody = {
        model: 'gpt-5.2',
        input: input,
        tools: [{ 
          type: 'image_generation',
          quality: body.quality || 'high',
          size: body.size || '1024x1024',
          input_fidelity: 'high'
        }]
      };
      
      const openaiResp = await fetch('https://api.openai.com/v1/responses', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(responsesBody)
      });
      
      const respText = await openaiResp.text();
      
      if (!openaiResp.ok) {
        return new Response(respText, {
          status: openaiResp.status,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }
      
      // Parse response and extract generated image
      const result = JSON.parse(respText);
      let imageB64 = null;
      
      // Look for image_generation_call in output
      if (result.output) {
        for (const item of result.output) {
          if (item.type === 'image_generation_call' && item.result) {
            imageB64 = item.result;
            break;
          }
        }
      }
      
      if (imageB64) {
        return new Response(JSON.stringify({ 
          data: [{ b64_json: imageB64 }],
          usage: result.usage 
        }), {
          status: 200,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      } else {
        return new Response(JSON.stringify({ 
          error: 'No image generated', 
          raw: respText.substring(0, 500) 
        }), {
          status: 500,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }
    }
    
    // Fallback: Image Edit API (multipart/form-data)
    const formData = new FormData();
    formData.append('model', body.model || 'gpt-image-1');
    formData.append('prompt', body.prompt);
    formData.append('size', body.size || '1024x1024');
    formData.append('quality', body.quality || 'high');
    
    for (let i = 0; i < (body.images || []).length; i++) {
      const img = body.images[i];
      const bytes = Uint8Array.from(atob(img.b64), c => c.charCodeAt(0));
      const ext = (img.mime || 'image/jpeg').includes('png') ? 'png' : 'jpeg';
      const blob = new Blob([bytes], { type: img.mime || 'image/jpeg' });
      formData.append('image[]', blob, `image_${i}.${ext}`);
    }

    const openaiResp = await fetch('https://api.openai.com/v1/images/edits', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}` },
      body: formData
    });

    const respText = await openaiResp.text();
    return new Response(respText, {
      status: openaiResp.status,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  } catch (err) {
    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
}
