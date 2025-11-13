import { useEffect, useMemo, useRef, useState } from 'react'
import Spline from '@splinetool/react-spline'

// Utility: Simple hash to generate deterministic values from prompt
function hashString(str) {
  let hash = 0
  for (let i = 0; i < str.length; i++) {
    hash = (hash << 5) - hash + str.charCodeAt(i)
    hash |= 0
  }
  return Math.abs(hash)
}

// Utility: Map hash to color palette (glowing cyan/blue variants)
function paletteFromPrompt(prompt) {
  const h = hashString(prompt)
  const hues = [190, 195, 200, 205, 210, 215] // blue-cyan range
  const hue = hues[h % hues.length]
  const sat = 80 + (h % 20)
  const light = 45 + (h % 10)
  return `hsl(${hue} ${sat}% ${light}%)`
}

// Encode AudioBuffer to WAV (PCM16)
function audioBufferToWavBlob(buffer) {
  const numOfChan = buffer.numberOfChannels
  const sampleRate = buffer.sampleRate
  const numFrames = buffer.length
  const bytesPerSample = 2
  const blockAlign = numOfChan * bytesPerSample
  const bufferLength = 44 + numFrames * blockAlign
  const arrayBuffer = new ArrayBuffer(bufferLength)
  const view = new DataView(arrayBuffer)

  // RIFF header
  function writeString(view, offset, string) {
    for (let i = 0; i < string.length; i++) {
      view.setUint8(offset + i, string.charCodeAt(i))
    }
  }

  let offset = 0
  writeString(view, offset, 'RIFF'); offset += 4
  view.setUint32(offset, 36 + numFrames * blockAlign, true); offset += 4
  writeString(view, offset, 'WAVE'); offset += 4
  writeString(view, offset, 'fmt '); offset += 4
  view.setUint32(offset, 16, true); offset += 4 // Subchunk1Size
  view.setUint16(offset, 1, true); offset += 2 // PCM
  view.setUint16(offset, numOfChan, true); offset += 2
  view.setUint32(offset, sampleRate, true); offset += 4
  view.setUint32(offset, sampleRate * blockAlign, true); offset += 4
  view.setUint16(offset, blockAlign, true); offset += 2
  view.setUint16(offset, 16, true); offset += 2 // bits per sample
  writeString(view, offset, 'data'); offset += 4
  view.setUint32(offset, numFrames * blockAlign, true); offset += 4

  // Write PCM
  const interleaved = new Float32Array(numFrames * numOfChan)
  for (let ch = 0; ch < numOfChan; ch++) {
    const channel = buffer.getChannelData(ch)
    for (let i = 0; i < numFrames; i++) {
      interleaved[i * numOfChan + ch] = channel[i]
    }
  }
  let idx = 44
  for (let i = 0; i < interleaved.length; i++) {
    let s = Math.max(-1, Math.min(1, interleaved[i]))
    view.setInt16(idx, s < 0 ? s * 0x8000 : s * 0x7fff, true)
    idx += 2
  }

  return new Blob([view], { type: 'audio/wav' })
}

// Generate ambient audio from prompt using OfflineAudioContext
async function generateAmbientAudioFromPrompt(prompt, seconds = 8) {
  const sampleRate = 44100
  const length = seconds * sampleRate
  const offline = new OfflineAudioContext(2, length, sampleRate)

  const baseFreq = 110 + (hashString(prompt) % 220)
  const detuneCents = (hashString(prompt + 'detune') % 200) - 100

  // Create evolving pad with two detuned oscillators
  const osc1 = offline.createOscillator()
  osc1.type = 'sawtooth'
  osc1.frequency.value = baseFreq
  osc1.detune.value = detuneCents

  const osc2 = offline.createOscillator()
  osc2.type = 'triangle'
  osc2.frequency.value = baseFreq / 2
  osc2.detune.value = -detuneCents

  // Noise layer
  const noiseBuffer = offline.createBuffer(1, length, sampleRate)
  const data = noiseBuffer.getChannelData(0)
  for (let i = 0; i < length; i++) {
    data[i] = (Math.random() * 2 - 1) * 0.02
  }
  const noise = offline.createBufferSource()
  noise.buffer = noiseBuffer

  // Filter and LFO
  const filter = offline.createBiquadFilter()
  filter.type = 'lowpass'
  filter.frequency.value = 800

  const lfo = offline.createOscillator()
  lfo.type = 'sine'
  lfo.frequency.value = 0.1 + (hashString(prompt + 'lfo') % 30) / 100 // 0.1 - 0.4 Hz

  const lfoGain = offline.createGain()
  lfoGain.gain.value = 600
  lfo.connect(lfoGain)
  lfoGain.connect(filter.frequency)

  // Master chain
  const master = offline.createGain()
  master.gain.setValueAtTime(0, 0)
  master.gain.linearRampToValueAtTime(0.8, 1)
  master.gain.linearRampToValueAtTime(0.6, seconds - 1)
  master.gain.linearRampToValueAtTime(0.0, seconds)

  const reverb = offline.createConvolver()
  // Simple impulse response
  const irLen = sampleRate * 2
  const ir = offline.createBuffer(2, irLen, sampleRate)
  for (let c = 0; c < 2; c++) {
    const ch = ir.getChannelData(c)
    for (let i = 0; i < irLen; i++) {
      ch[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / irLen, 3) * 0.6
    }
  }
  reverb.buffer = ir

  const oscGain = offline.createGain()
  oscGain.gain.value = 0.3

  const noiseGain = offline.createGain()
  noiseGain.gain.value = 0.15

  osc1.connect(oscGain)
  osc2.connect(oscGain)
  noise.connect(filter)
  filter.connect(noiseGain)

  const mix = offline.createGain()
  oscGain.connect(mix)
  noiseGain.connect(mix)
  mix.connect(reverb)
  mix.connect(master)
  reverb.connect(master)
  master.connect(offline.destination)

  osc1.start(0)
  osc2.start(0)
  noise.start(0)
  lfo.start(0)
  osc1.stop(seconds)
  osc2.stop(seconds)
  noise.stop(seconds)
  lfo.stop(seconds)

  const rendered = await offline.startRendering()
  const wavBlob = audioBufferToWavBlob(rendered)
  return { blob: wavBlob, duration: seconds }
}

// Generate procedural video via Canvas + MediaRecorder
async function generateProceduralVideo(prompt, seconds = 6, fps = 30, width = 720, height = 1280) {
  return new Promise(async (resolve, reject) => {
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d')

    const stream = canvas.captureStream(fps)
    const recorder = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp9' })
    const chunks = []
    recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data)
    recorder.onstop = () => {
      resolve(new Blob(chunks, { type: 'video/webm' }))
    }

    const color = paletteFromPrompt(prompt)
    const start = performance.now()

    function draw(t) {
      const elapsed = (t - start) / 1000
      // Background gradient
      const grd = ctx.createLinearGradient(0, 0, width, height)
      grd.addColorStop(0, '#05070a')
      grd.addColorStop(1, '#0b1220')
      ctx.fillStyle = grd
      ctx.fillRect(0, 0, width, height)

      // Energy ring
      const cx = width / 2
      const cy = height / 2
      const maxR = Math.min(width, height) * 0.35
      ctx.save()
      ctx.translate(cx, cy)
      ctx.rotate(elapsed * 0.6)
      for (let i = 0; i < 60; i++) {
        const angle = (i / 60) * Math.PI * 2
        const r = maxR * (0.7 + 0.25 * Math.sin(elapsed * 2 + i))
        ctx.strokeStyle = color
        ctx.globalAlpha = 0.65
        ctx.lineWidth = 2
        ctx.beginPath()
        ctx.arc(0, 0, r, angle, angle + 0.04)
        ctx.stroke()
      }
      ctx.restore()

      // Prompt ribbon
      ctx.globalAlpha = 0.9
      ctx.strokeStyle = color
      ctx.lineWidth = 3
      ctx.beginPath()
      for (let i = 0; i < 200; i++) {
        const x = (i / 199) * width
        const y = height / 2 + Math.sin((i / 15) + elapsed * 2) * 80 + Math.cos((i / 7) + elapsed * 1.3) * 40
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y)
      }
      ctx.stroke()

      // Prompt text
      ctx.globalAlpha = 0.95
      ctx.fillStyle = '#c7f0ff'
      ctx.font = '600 28px Manrope, Inter, system-ui, sans-serif'
      const lines = wrapText(prompt, width * 0.8, ctx)
      const textY = cy - lines.length * 18
      lines.forEach((line, idx) => {
        const tw = ctx.measureText(line).width
        const x = cx - tw / 2
        const y = textY + idx * 32
        ctx.fillText(line, x, y)
      })

      if (elapsed < seconds) {
        requestAnimationFrame(draw)
      } else {
        recorder.stop()
      }
    }

    function wrapText(text, maxWidth, context) {
      const words = text.split(' ')
      const lines = []
      let current = ''
      for (let w of words) {
        const test = current ? current + ' ' + w : w
        const width = context.measureText(test).width
        if (width > maxWidth && current) {
          lines.push(current)
          current = w
        } else {
          current = test
        }
      }
      if (current) lines.push(current)
      return lines.slice(0, 4) // cap lines
    }

    recorder.start()
    requestAnimationFrame(draw)
  })
}

// Merge: re-render video with same prompt but duration of audio; mix audio via MediaStreamDestination
async function renderMergedAV(prompt, audioBlob, fps = 30) {
  const audioCtx = new (window.AudioContext || window.webkitAudioContext)()
  const arrayBuf = await audioBlob.arrayBuffer()
  const decoded = await audioCtx.decodeAudioData(arrayBuf.slice(0))
  const duration = decoded.duration

  const canvas = document.createElement('canvas')
  const width = 720, height = 1280
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')

  const dest = audioCtx.createMediaStreamDestination()
  const src = audioCtx.createBufferSource()
  src.buffer = decoded
  src.connect(dest)
  src.connect(audioCtx.destination)

  const stream = new MediaStream()
  const canvasStream = canvas.captureStream(fps)
  canvasStream.getVideoTracks().forEach((t) => stream.addTrack(t))
  dest.stream.getAudioTracks().forEach((t) => stream.addTrack(t))

  const recorder = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp9,opus' })
  const chunks = []
  recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data)

  const color = paletteFromPrompt(prompt)
  const start = performance.now()

  function draw(t) {
    const elapsed = (t - start) / 1000
    // Background
    const grd = ctx.createLinearGradient(0, 0, width, height)
    grd.addColorStop(0, '#05070a')
    grd.addColorStop(1, '#0b1220')
    ctx.fillStyle = grd
    ctx.fillRect(0, 0, width, height)

    // Rotating ring
    const cx = width / 2
    const cy = height / 2
    const maxR = Math.min(width, height) * 0.35
    ctx.save()
    ctx.translate(cx, cy)
    ctx.rotate(elapsed * 0.7)
    for (let i = 0; i < 60; i++) {
      const angle = (i / 60) * Math.PI * 2
      const r = maxR * (0.7 + 0.25 * Math.sin(elapsed * 2 + i))
      ctx.strokeStyle = color
      ctx.globalAlpha = 0.65
      ctx.lineWidth = 2
      ctx.beginPath()
      ctx.arc(0, 0, r, angle, angle + 0.04)
      ctx.stroke()
    }
    ctx.restore()

    // Text overlay
    ctx.globalAlpha = 0.95
    ctx.fillStyle = '#c7f0ff'
    ctx.font = '600 28px Manrope, Inter, system-ui, sans-serif'
    const lines = wrapText(prompt, width * 0.8, ctx)
    const textY = cy - lines.length * 18
    lines.forEach((line, idx) => {
      const tw = ctx.measureText(line).width
      const x = cx - tw / 2
      const y = textY + idx * 32
      ctx.fillText(line, x, y)
    })

    if (elapsed < duration) {
      requestAnimationFrame(draw)
    }
  }

  function wrapText(text, maxWidth, context) {
    const words = text.split(' ')
    const lines = []
    let current = ''
    for (let w of words) {
      const test = current ? current + ' ' + w : w
      const width = context.measureText(test).width
      if (width > maxWidth && current) {
        lines.push(current)
        current = w
      } else {
        current = test
      }
    }
    if (current) lines.push(current)
    return lines.slice(0, 4)
  }

  return new Promise((resolve) => {
    recorder.onstop = () => {
      resolve(new Blob(chunks, { type: 'video/webm' }))
    }
    recorder.start()
    requestAnimationFrame(draw)
    // Start audio slightly after recorder starts
    setTimeout(() => {
      src.start()
    }, 50)
    setTimeout(() => {
      recorder.stop()
    }, Math.ceil(duration * 1000) + 100)
  })
}

function EnergyLoader({ show }) {
  return (
    <div className={`transition-opacity ${show ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}>
      <div className="mx-auto mt-6 w-20 h-20 rounded-full border-4 border-cyan-300/30 border-t-cyan-400 animate-spin shadow-[0_0_20px_#22d3ee]" />
    </div>
  )
}

export default function App() {
  const [prompt, setPrompt] = useState('A dark biomechanical lord awakens amidst thunder')
  const [audioBlob, setAudioBlob] = useState(null)
  const [videoBlob, setVideoBlob] = useState(null)
  const [mergedBlob, setMergedBlob] = useState(null)
  const [loading, setLoading] = useState('') // '', 'audio', 'video', 'merge'
  const videoRef = useRef(null)
  const mergedRef = useRef(null)
  const color = useMemo(() => paletteFromPrompt(prompt), [prompt])

  const generateAudio = async () => {
    try {
      setLoading('audio')
      const { blob } = await generateAmbientAudioFromPrompt(prompt, 8)
      setAudioBlob(blob)
    } catch (e) {
      console.error(e)
      alert('Audio generation failed. Please try again.')
    } finally {
      setLoading('')
    }
  }

  const generateVideo = async () => {
    try {
      setLoading('video')
      const blob = await generateProceduralVideo(prompt, 6, 30)
      setVideoBlob(blob)
    } catch (e) {
      console.error(e)
      alert('Video generation failed. Please try again.')
    } finally {
      setLoading('')
    }
  }

  const mergeAndPreview = async () => {
    if (!audioBlob) return alert('Generate audio first.')
    try {
      setLoading('merge')
      const blob = await renderMergedAV(prompt, audioBlob, 30)
      setMergedBlob(blob)
      // Auto-scroll to preview
      setTimeout(() => {
        mergedRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })
      }, 100)
    } catch (e) {
      console.error(e)
      alert('Merge failed. Please try again.')
    } finally {
      setLoading('')
    }
  }

  const audioUrl = useMemo(() => (audioBlob ? URL.createObjectURL(audioBlob) : null), [audioBlob])
  const videoUrl = useMemo(() => (videoBlob ? URL.createObjectURL(videoBlob) : null), [videoBlob])
  const mergedUrl = useMemo(() => (mergedBlob ? URL.createObjectURL(mergedBlob) : null), [mergedBlob])

  useEffect(() => {
    return () => {
      if (audioUrl) URL.revokeObjectURL(audioUrl)
      if (videoUrl) URL.revokeObjectURL(videoUrl)
      if (mergedUrl) URL.revokeObjectURL(mergedUrl)
    }
  }, [audioUrl, videoUrl, mergedUrl])

  return (
    <div className="min-h-screen w-full bg-[#05070a] text-white">
      {/* Hero with Spline */}
      <div className="relative h-[60vh] sm:h-[70vh]">
        <div className="absolute inset-0">
          <Spline scene="https://prod.spline.design/EF7JOSsHLk16Tlw9/scene.splinecode" style={{ width: '100%', height: '100%' }} />
        </div>
        <div className="absolute inset-0 bg-gradient-to-b from-transparent via-[#05070a]/10 to-[#05070a] pointer-events-none" />
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="px-6 text-center">
            <h1 className="text-3xl sm:text-5xl font-extrabold tracking-tight" style={{ textShadow: '0 0 24px rgba(34,211,238,0.45)' }}>
              AuralForge – Create the Unseen and Unheard
            </h1>
            <p className="mt-4 text-cyan-200/80 max-w-2xl mx-auto">
              Turn a single prompt into evocative soundscapes and mesmerizing visuals.
            </p>
          </div>
        </div>
      </div>

      {/* Generator Panel */}
      <div className="max-w-5xl mx-auto px-4 -mt-20">
        <div className="rounded-2xl border border-cyan-400/20 bg-[#0b1220]/70 backdrop-blur-md shadow-[0_0_40px_rgba(34,211,238,0.15)]">
          <div className="p-6 sm:p-8">
            <div className="flex flex-col gap-4">
              <input
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder="Describe your vision..."
                className="w-full rounded-xl bg-[#0a0f1a] border border-cyan-400/30 px-4 py-4 text-base outline-none focus:ring-2 ring-cyan-400/60 shadow-[inset_0_0_12px_rgba(34,211,238,0.15)]"
                style={{ boxShadow: 'inset 0 0 20px rgba(34,211,238,0.12)' }}
              />

              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-2">
                <button onClick={generateAudio} disabled={!!loading}
                        className={`rounded-lg px-4 py-3 font-semibold transition ${loading==='audio' ? 'bg-cyan-500/30' : 'bg-cyan-500 hover:bg-cyan-400'} text-black`}>
                  Generate Audio
                </button>
                <button onClick={generateVideo} disabled={!!loading}
                        className={`rounded-lg px-4 py-3 font-semibold transition ${loading==='video' ? 'bg-cyan-500/30' : 'bg-cyan-500 hover:bg-cyan-400'} text-black`}>
                  Generate Video
                </button>
                <button onClick={mergeAndPreview} disabled={!!loading || !audioBlob}
                        className={`rounded-lg px-4 py-3 font-semibold transition ${loading==='merge' ? 'bg-cyan-500/30' : 'bg-cyan-500 hover:bg-cyan-400'} text-black col-span-2 sm:col-span-1`}>
                  Merge & Preview
                </button>
                <a
                  href={mergedUrl || videoUrl || audioUrl || '#'}
                  download={`auralforge-${Date.now()}.${mergedUrl ? 'webm' : videoUrl ? 'webm' : 'wav'}`}
                  className={`rounded-lg px-4 py-3 font-semibold transition text-black text-center ${mergedUrl || videoUrl || audioUrl ? 'bg-cyan-500 hover:bg-cyan-400' : 'bg-cyan-500/30 pointer-events-none'}`}
                >
                  Download
                </a>
              </div>

              <EnergyLoader show={!!loading} />

              {/* Results */}
              <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mt-4">
                <div className="md:col-span-1">
                  <h3 className="text-cyan-200/80 font-semibold mb-2">Audio</h3>
                  <div className="rounded-xl border border-cyan-400/20 bg-[#07101a] p-4">
                    {audioUrl ? (
                      <audio controls src={audioUrl} className="w-full" />
                    ) : (
                      <p className="text-cyan-100/50">No audio yet.</p>
                    )}
                  </div>
                </div>

                <div className="md:col-span-1">
                  <h3 className="text-cyan-200/80 font-semibold mb-2">Video</h3>
                  <div className="rounded-xl border border-cyan-400/20 bg-[#07101a] p-4">
                    {videoUrl ? (
                      <video ref={videoRef} controls src={videoUrl} className="w-full rounded-lg" />
                    ) : (
                      <p className="text-cyan-100/50">No video yet.</p>
                    )}
                  </div>
                </div>

                <div className="md:col-span-1" ref={mergedRef}>
                  <h3 className="text-cyan-200/80 font-semibold mb-2">Merged Preview</h3>
                  <div className="rounded-xl border border-cyan-400/20 bg-[#07101a] p-4">
                    {mergedUrl ? (
                      <video controls src={mergedUrl} className="w-full rounded-lg" />
                    ) : (
                      <p className="text-cyan-100/50">Generate audio, then Merge & Preview.</p>
                    )}
                  </div>
                </div>
              </div>

              {/* Advanced users: API key note */}
              <div className="mt-6 text-xs text-cyan-200/60">
                Optional: You can swap the local generators with your favorite AI APIs (OpenAI, Pika, Runway, etc.) using fetch and an API key. This demo runs fully in your browser with no server.
              </div>
            </div>
          </div>
        </div>

        {/* Ambient glow */}
        <div className="relative h-32">
          <div className="absolute inset-x-0 top-6 mx-auto h-32 w-3/4 rounded-full blur-3xl" style={{ background: `radial-gradient(ellipse at center, ${color}33, transparent 70%)` }} />
        </div>
      </div>
    </div>
  )
}
