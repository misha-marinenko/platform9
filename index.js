/* global window, document, $, requestAnimationFrame, AudioContext, MediaRecorder, URL */
const createSwarm = require('killa-beez')
const getUserMedia = require('getusermedia')
const qs = require('querystring')
const mediaRecorder = require('media-recorder-stream')
const bel = require('bel')
const FileWriteStream = require('filestream/write')
const xhr = require('xhr')
const UserStorage = require('./lib/storage')
const views = require('./lib/views')

// Convenience functions
const byId = id => document.getElementById(id)
const selector = exp => document.querySelector(exp)
const selectall = exp => document.querySelectorAll(exp)
const values = obj => Object.keys(obj).map(k => obj[k])

// Services for exchanges.
const signalHost = 'https://signalexchange.now.sh'
const roomHost = 'https://roomexchange.now.sh'
const CLOSE_WARNING = 'The call is still recording and will not be saved. Close the window anyway?'
// Create User storage instance
const storage = new UserStorage()

if (typeof window.AudioContext !== 'function' || typeof window.MediaRecorder !== 'function') {
  byId('messages-container').appendChild(views.message({
    icon: 'frown',
    type: 'warning',
    title: 'Your browser is not supported',
    message: 'To use rollcall, we recommend using the latest version of Chrome or Mozilla Firefox'
  }))

  throw new Error(`Unsupported browser ${window.navigator.userAgent}`)
}

const context = new AudioContext()
const waudio = require('waudio')(context)

const recordButton = bel `
<button id="record" class="ui compact labeled icon button">
  <i class="circle icon"></i>
  <span>Record</span>
</button>
`

const settingsButton = bel `
<button id="settings" class="ui compact icon button">
  <i class="settings icon"></i>
</button>
`

const mimeType = [
  'audio/webm;codecs=opus',
  'audio/ogg;codecs=opus',
  'audio/ogg;codecs=vorbis'
].filter((type) => {
  if (typeof MediaRecorder.isTypeSupported === 'function') {
    return MediaRecorder.isTypeSupported(type)
  }

  return false
})[0]

const worker = new window.Worker('/worker.js')

// listen for messages from the worker
worker.onmessage = (e) => {
  const data = e.data || {}
  if (data.type === 'compressed') {
    bel `<a href="${data.url}" download="${data.name}"></a>`.click()
    $('#record i')
      .removeClass('notched circle loading')
      .addClass('download')
    $('#record span')
      .text('Download Zip')
  }
}

// This is the only
const masterSoundOutput = waudio(true)

function addAudioFile (file) {
  let audio = waudio(file)
  audio.connect(masterSoundOutput)
  let elem = views.audioFile(file, audio, context)

  connectAudio(elem, audio)
  byId('audio-container').appendChild(elem)

  return audio
}

function recordingName (pubkey, delay) {
  let text = $(`#a${pubkey} div.person-name`).text()
  if (delay) text += '-' + delay
  return text + '.webm'
}

function formatFileSize (bytes) {
  const kB = bytes / 1000
  if (kB >= 1000) {
    return Math.floor(kB / 1000) + 'MB'
  } else {
    return Math.floor(kB) + 'kB'
  }
}

function connectRecording (pubkey, stream) {
  let classes = 'spinner loading icon download-icon'
  let elem = bel `
  <div class="downloads">
    <div class="ui inverted divider"></div>
    <div class="ui basic button record-download">
      <i class="${classes}"></i><span class="bits"></span>
    </div>
  </div>`

  selector(`#a${pubkey} div.extra`).appendChild(elem)
  let span = selector(`#a${pubkey} span.bits`)
  let bytes = 0
  stream.on('data', data => {
    bytes += data.length
    span.textContent = formatFileSize(bytes)
  })
  span.textContent = formatFileSize(0)

  let button = selector(`#a${pubkey} div.downloads div.button`)
  $(button).addClass('disabled')

  let ret = file => {
    $(`#a${pubkey} div.downloads i`)
      .removeClass('spinner')
      .removeClass('loading')
      .addClass('download')

    $(button).removeClass('disabled').addClass('enabled')

    button.publicKey = pubkey
    button.recordingFile = file
    button.recordingDelay = ret.recordingDelay
    button.onclick = () => {
      let n = recordingName(pubkey, button.recordingDelay)
      bel `<a href="${URL.createObjectURL(file)}" download="${n}"></a>`.click()
    }
    removeWindowCloseHandler()
    enableZipDownload()
  }
  return ret
}

function enableZipDownload () {
  let elements = selectall('i.download-icon')
  for (let i = 0; i < elements.length; i++) {
    let el = elements[i]
    if ($(el).hasClass('spinner')) return
  }

  $('#record i')
    .removeClass('notched circle loading red blink')
    .addClass('download')
  $('#record span')
    .text('Download Zip')

  let downloadZip = () => {
    recordButton.onclick = () => {}

    $('#record i')
      .removeClass('download')
      .addClass('notched circle loading')
    $('#record span')
      .text('Loading...')

    // inform worker to create a zip file
    worker.postMessage({
      type: 'compress',
      room: window.RollCallRoom,
      files: Array(...selectall('div.record-download')).map(button => {
        return {
          name: recordingName(button.publicKey, button.recordingDelay),
          file: button.recordingFile
        }
      })
    })
  }

  recordButton.onclick = downloadZip
}

const recordingStreams = {}

function recording (swarm, microphone) {
  let remotes = []

  function startRecording () {
    let me = mediaRecorder(microphone, {
      mimeType
    })
    let writer = FileWriteStream()
    me.pipe(writer)
    writer.publicKey = swarm.publicKey
    me.publicKey = swarm.publicKey

    let onFile = connectRecording('undefined', me)
    writer.on('file', onFile)

    let starttime = Date.now()

    swarm.on('substream', (stream, id) => {
      if (id.slice(0, 'recording:'.length) !== 'recording:') return
      let pubkey = id.slice('recording:'.length)
      let writer = FileWriteStream()
      writer.publicKey = swarm.publicKey
      stream.pipe(writer)

      recordingStreams[pubkey] = stream

      let onFile = connectRecording(pubkey, stream)
      onFile.recordingDelay = Date.now() - starttime
      writer.on('file', onFile)
    })

    remotes.forEach(commands => commands.record())
    let onRecording = commands => {
      commands.record()
    }
    swarm.on('commands:recording', onRecording)

    recordButton.onclick = () => {
      me.stop()
      remotes.forEach(commands => commands.stopRecording())
      swarm.removeListener('commands:recording', onRecording)

      $('#record i')
        .removeClass('stop')
        .addClass('notched circle loading')
      $('#record span')
        .text('Loading...')
    }

    $('button#record i')
      .removeClass('unmute')
      .addClass('red blink')
    $('#record span')
      .text('Stop')
    addWindowCloseHandler()
  }

  function mkrpc (peer) {
    // Create RPC services scoped to this peer.
    let rpc = {}
    let stream
    rpc.record = () => {
      $(recordButton).addClass('disabled')
      stream = mediaRecorder(microphone, {
        mimeType
      })
      stream.pipe(peer.meth.stream(`recording:${swarm.publicKey}`))
    }
    rpc.stopRecording = () => {
      stream.stop()
      $(recordButton).addClass('enabled').removeClass('disabled')
    }
    peer.meth.commands(rpc, 'recording')
  }

  swarm.on('peer', mkrpc)
  values(swarm.peers).forEach(mkrpc)
  swarm.on('commands:recording', commands => {
    remotes.push(commands)
  })

  return startRecording
}

function getRtcConfig (cb) {
  xhr({
    url: 'https://instant.io/_rtcConfig',
    timeout: 10000
  }, (err, res) => {
    if (err || res.statusCode !== 200) {
      cb(new Error('Could not get WebRTC config from server. Using default (without TURN).'))
    } else {
      var rtcConfig
      try {
        rtcConfig = JSON.parse(res.body)
      } catch (err) {
        return cb(new Error('Got invalid WebRTC config from server: ' + res.body))
      }
      cb(null, rtcConfig)
    }
  })
}

function joinRoom (room) {
  room = `peer-call:${room}`
  const deviceId = storage.get('input')

  let audioopts = {
    echoCancellation: true,
    volume: 0.9,
    deviceId: deviceId ? {exact: deviceId} : undefined
  }
  let mediaopts = {
    audio: audioopts,
    video: false
  }

  const message = views.message({
    icon: 'unmute',
    title: 'Platform9 would like to access your microphone'
  })

  byId('messages-container').appendChild(message)

  getUserMedia(mediaopts, (err, audioStream) => {
    if (err) console.error(err)

    let output = waudio(audioStream ? audioStream.clone() : null)
    let myelem = views.remoteAudio(storage)
    connectAudio(myelem, output)

    message.update({
      icon: 'notched circle loading',
      title: 'Hang on tight',
      message: 'We are establishing a connection to your room, please be patient...'
    })
    getRtcConfig((err, rtcConfig) => {
      if (err) console.error(err) // non-fatal error

      let swarm = createSwarm(signalHost, {
        stream: output.stream,
        config: rtcConfig
      })
      let myinfo = {
        username: storage.get('username') || null,
        publicKey: swarm.publicKey
      }
      swarm.log.add(null, myinfo)
      let usernames = {}
      swarm.feed.on('data', node => {
        let doc = node.value
        if (doc.username && doc.publicKey) {
          usernames[doc.publicKey] = doc.username
          $(`#a${doc.publicKey} div.person-name`).text(doc.username)
        }
      })
      swarm.joinRoom(roomHost, room)
      swarm.on('stream', stream => {
        let audio = waudio(stream)
        audio.connect(masterSoundOutput)
        let remotes = values(swarm.peers).length
        let publicKey = stream.peer.publicKey
        let username = usernames[publicKey] || `Caller (${remotes})`
        let elem = views.remoteAudio(storage, username, publicKey)
        connectAudio(elem, audio)
        byId('audio-container').appendChild(elem)
      })
      swarm.on('disconnect', pubKey => {
        if (recordingStreams[pubKey]) {
          recordingStreams[pubKey].emit('end')
        } else {
          $(`#a${pubKey}`).remove()
        }
      })

      byId('audio-container').appendChild(myelem)
      byId('messages-container').removeChild(message)

      const topBar = byId('top-bar')
      topBar.appendChild(settingsButton)
      topBar.appendChild(views.shareButton())
      topBar.appendChild(recordButton)

      views.settingsModal(storage).then((modal) => {
        document.body.appendChild(modal)
        settingsButton.onclick = () => $(modal).modal('show')
      })

      // Show a warning message if a user can not record audio
      if (typeof mimeType !== 'string' && typeof MediaRecorder.isTypeSupported === 'function') {
        recordButton.setAttribute('disabled', true)
        $(recordButton).find('span').html(`Recording not supported`)
      } else {
        recordButton.onclick = recording(swarm, output.stream)
      }

      views.dragDrop((files) => {
        files.forEach(file => {
          let audio = addAudioFile(file)
          // output.add(gain.inst)
          audio.connect(output)
        })
      })

      if (!audioStream) {
        topBar.appendChild(bel `<div class="error notice">Listening only: no audio input available.</div>`)
      }
    })
  })
}

const WIDTH = 290
const HEIGHT = 49
let looping

function startLoop () {
  if (looping) return

  let lastTime = Date.now()

  function draw () {
    requestAnimationFrame(draw)
    var now = Date.now()
    if (now - lastTime < 50) return

    var elements = [...selectall('canvas.person')]
    elements.forEach(drawPerson)

    function drawPerson (canvas) {
      var canvasCtx = canvas.canvasCtx
      var analyser = canvas.analyser
      var bufferLength = analyser._bufferLength

      var dataArray = new Uint8Array(bufferLength)

      analyser.getByteFrequencyData(dataArray)

      canvasCtx.clearRect(0, 0, WIDTH, HEIGHT)
      var barWidth = (WIDTH / bufferLength) * 5
      var barHeight
      var x = 0
      var total = 0
      for (var i = 0; i < bufferLength; i++) {
        barHeight = dataArray[i] / 3
        if (barHeight > 10) {
          canvasCtx.fillStyle = 'rgb(66,133,244)'
          canvasCtx.fillRect(x, HEIGHT - barHeight / 2, barWidth, barHeight)
        }
        x += barWidth + 1
        total += barHeight
      }
      lastTime = now

      if (total > 1000) {
        $(canvas.parentNode.parentNode).addClass('pulse')
      } else {
        $(canvas.parentNode.parentNode).removeClass('pulse')
      }
    }
  }
  draw()
  looping = true
}
/*
  Custom beforeunload messages have been deprecated in most browsers
  for security reasons, but for those that support we'll pass a
  custom message.
*/
function showConfirmMessage (e = {}) {
  let confirmationMessage = CLOSE_WARNING
  e.returnValue = confirmationMessage
  return confirmationMessage
}

function addWindowCloseHandler () {
  window.addEventListener('beforeunload', showConfirmMessage)
}

function removeWindowCloseHandler () {
  window.removeEventListener('beforeunload', showConfirmMessage)
}

function connectAudio (element, audio) {
  let analyser = context.createAnalyser()
  let volumeSelector = 'input[type=range]'
  let muteSelector = 'input[type=checkbox]'
  let muteElement = element.querySelector(muteSelector)

  element.userGain = 1

  $(muteElement).checkbox('toggle').click(c => {
    let label = c.target.parentNode.querySelector('label')
    if (label.children[0].classList.contains('mute')) {
      label.innerHTML = '<i class=\'icon unmute\'></i>'
      element.querySelector(volumeSelector).disabled = false
      audio.volume(element.userGain)
    } else {
      label.innerHTML = '<i class=\'icon mute red\'></i>'
      element.querySelector(volumeSelector).disabled = true
      audio.volume(0)
    }
  })

  $(element.querySelector(volumeSelector)).change(function () {
    audio.volume(this.value)
    element.userGain = this.value
  })
  audio.connect(analyser)

  var canvas = element.querySelector('canvas.person')
  canvas.canvasCtx = canvas.getContext('2d')
  analyser.fftSize = 256
  analyser._bufferLength = analyser.frequencyBinCount
  canvas.canvasCtx.clearRect(0, 0, WIDTH, HEIGHT)
  canvas.analyser = analyser
  startLoop()

  return element
}
$(() => {
  if (window.location.search) {
    let opts = qs.parse(window.location.search.slice(1))
    if (opts.room) {
      window.RollCallRoom = opts.room
      return joinRoom(opts.room)
    }
  }
  byId('main-container').appendChild(views.mainButtons)
})
