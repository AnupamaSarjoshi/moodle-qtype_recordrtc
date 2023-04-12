// This file is part of Moodle - http://moodle.org/
//
// Moodle is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// Moodle is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU General Public License for more details.
//
// You should have received a copy of the GNU General Public License
// along with Moodle.  If not, see <http://www.gnu.org/licenses/>.
//

/**
 * JavaScript to the recording work.
 *
 * We would like to thank the creators of atto_recordrtc, whose
 * work originally inspired this.
 *
 * This script uses some third-party JavaScript and loading that within Moodle/ES6
 * requires some contortions. The main classes here are:
 *
 * * Recorder - represents one recording widget. This works in a way that is
 *   not particularly specific to this question type.
 * * RecordRtcQuestion - represents one question, which may contain several recorders.
 *   It deals with the interaction between the recorders and the question.
 *
 * @module    qtype_recordrtc/avrecording
 * @copyright 2019 The Open University
 * @license   http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */

import Log from 'core/log';
import ModalFactory from 'core/modal_factory';

/**
 * Verify that the question type can work. If not, show a warning.
 *
 * @return {string} 'ok' if it looks OK, else 'nowebrtc' or 'nothttps' if there is a problem.
 */
function checkCanWork() {
    // Check APIs are known.
    if (!(navigator.mediaDevices && window.MediaRecorder)) {
        return 'nowebrtc';
    }

    // Check protocol (localhost).
    if (location.protocol === 'https:' ||
            location.host === 'localhost' || location.host === '127.0.0.1') {
        return 'ok';
    } else {
        return 'nothttps';
    }
}

/**
 * Object for actually doing the recording.
 *
 * The recorder can be in one of several states, which is stored in a data-state
 * attribute on the outer span (widget). The states are:
 *
 *  - new:       there is no recording yet. Button shows 'Start recording' (audio) or 'Start camera' (video).
 *  - starting:  (video only) camera has started, but we are not recording yet. Button show 'Start recording'.
 *  - recording: Media is being recorded. Pause button visible if allowed. Main button shows 'Stop'. Countdown displayed.
 *  - paused:    If pause was pressed. Media recording paused, but resumable. Pause button changed to say 'resume'.
 *  - saving:    Media being uploaded. Progress indication shown. Pause button hidden if was visible.
 *  - recorded:  Recording and upload complete. Buttons shows 'Record again'.
 *
 * @param {HTMLElement} widget the DOM node that is the top level of the whole recorder.
 * @param {(AudioSettings|VideoSettings)} mediaSettings information about the media type.
 * @param {Object} owner the object we are doing the recording for. Must provide three callback functions
 *                       showAlert notifyRecordingComplete notifyButtonStatesChanged.
 * @param {Object} uploadInfo object with fields uploadRepositoryId, draftItemId, contextId and maxUploadSize.
 * @constructor
 */
function Recorder(widget, mediaSettings, owner, uploadInfo) {
    /**
     * @type {Recorder} reference to this recorder, for use in event handlers.
     */
    const recorder = this;

    /**
     * @type {MediaStream} during recording, the stream of incoming media.
     */
    let mediaStream = null;

    /**
     * @type {MediaRecorder} the recorder that is capturing stream.
     */
    let mediaRecorder = null;

    /**
     * @type {Blob[]} the chunks of data that have been captured so far during the current recording.
     */
    let chunks = [];

    /**
     * @type {number} number of bytes recorded so far, so we can auto-stop
     * before hitting Moodle's file-size limit.
     */
    let bytesRecordedSoFar = 0;

    /**
     * @type {number} when paused, the time left in milliseconds, so we can auto-stop at the time limit.
     */
    let timeRemaining = 0;

    /**
     * @type {number} while recording, the time we reach the time-limit, so we can auto-stop then.
     * This is milliseconds since Unix epoch, so comparable with Date.now().
     */
    let stopTime = 0;

    /**
     * @type {number} intervalID returned by setInterval() while the timer is running.
     */
    let countdownTicker = 0;

    const button = widget.querySelector('button.qtype_recordrtc-main-button');
    const pauseButton = widget.querySelector('.qtype_recordrtc-pause-button button');
    const controlRow = widget.querySelector('.qtype_recordrtc-control-row');
    const mediaElement = widget.querySelector('.qtype_recordrtc-media-player ' +
        (mediaSettings.name === 'screen' ? 'video' : mediaSettings.name));
    const noMediaPlaceholder = widget.querySelector('.qtype_recordrtc-no-recording-placeholder');
    const timeDisplay = widget.querySelector('.qtype_recordrtc-time-left');
    const progressBar = widget.querySelector('.qtype_recordrtc-time-left .qtype_recordrtc-timer-front');
    const backTimeEnd = widget.querySelector('.qtype_recordrtc-time-left .qtype_recordrtc-timer-back span.timer-end');
    const backtimeStart = widget.querySelector('.qtype_recordrtc-time-left .qtype_recordrtc-timer-back span.timer-start');
    const frontTimeEnd = widget.querySelector('.qtype_recordrtc-time-left .qtype_recordrtc-timer-front span.timer-end');
    const fronttimeStart = widget.querySelector('.qtype_recordrtc-time-left .qtype_recordrtc-timer-front span.timer-start');

    widget.addEventListener('click', handleButtonClick);
    this.uploadMediaToServer = uploadMediaToServer; // Make this method available.

    /**
     * Handles clicks on the start/stop and pause buttons.
     *
     * @param {Event} e
     */
    function handleButtonClick(e) {
        const clickedButton = e.target.closest('button');
        if (!clickedButton) {
            return; // Not actually a button click.
        }
        e.preventDefault();
        switch (widget.dataset.state) {
            case 'new':
            case 'recorded':
                startRecording();
                break;
            case 'starting':
                if (mediaSettings.name === 'screen') {
                    startScreenSaving();
                } else {
                    startSaving();
                }
                break;
            case 'recording':
                if (clickedButton === pauseButton) {
                    pause();
                } else {
                    stopRecording();
                }
                break;
            case 'paused':
                if (clickedButton === pauseButton) {
                    resume();
                } else {
                    stopRecording();
                }
                break;
        }
    }

    /**
     * Get list media device supported.
     *
     * @param {Function} A callback function to handle next step.
     */
    function getMediaDevices(callback) {
        navigator.mediaDevices.enumerateDevices().then(callback).catch(handleScreenSharingError);
    }

    /**
     * Get audio mic stream.
     *
     * @param {Function} A callback function to handle next step.
     */
    function getAudioMedia(callback) {
        navigator.mediaDevices.getUserMedia({audio: true}).then(callback).catch(handleScreenSharingError);
    }

    /**
     * To handle every time the audio mic has a problem.
     * For now, we will allow video to be saved without sound when there is an error with the microphone.
     *
     * @param {Object} A error object.
     */
    function handleScreenSharingError(error) {
        Log.debug(error);
        startSaving();
    }

    /**
     * When recorder type is screen, we need add audio mic stream into mediaStream
     * before saving.
     */
    function startScreenSaving() {
        // We need to combine 2 audio and screen-sharing streams to create a recording with audio from the mic.
        getMediaDevices(devices => {
            let composedStream = new MediaStream();
            // Get audio stream from microphone.
            getAudioMedia(micStream => {
                // When the user shares their screen, we need to merge the video track from the media stream with
                // the audio track from the microphone stream and stop any unnecessary tracks to ensure
                // that the recorded video has microphone sound.
                mediaStream.getTracks().forEach(function(track) {
                    if (track.kind === 'video') {
                        // Add video track into stream.
                        composedStream.addTrack(track);
                    } else {
                        // Stop any audio track.
                        track.stop();
                    }
                });

                // Add mic audio track from mic stream into composedStream to track audio.
                // This will make sure the recorded video will have mic sound.
                micStream.getAudioTracks().forEach(function(micTrack) {
                    composedStream.addTrack(micTrack);
                });
                mediaStream = composedStream;
                startSaving();
            });
        });
    }

    /**
     * Start recording (because the button was clicked).
     */
    function startRecording() {

        // Reset timer label.
        setLabelForTimer(0, parseInt(widget.dataset.maxRecordingDuration));

        if (mediaSettings.name === 'audio') {
            mediaElement.parentElement.classList.add('hide');
            noMediaPlaceholder.classList.add('hide');
            timeDisplay.classList.remove('hide');

        } else {
            mediaElement.parentElement.classList.remove('hide');
            noMediaPlaceholder.classList.add('hide');
        }
        pauseButton?.parentElement.classList.remove('hide');

        // Change look of recording button.
        button.classList.remove('btn-outline-danger');
        button.classList.add('btn-danger');

        // Disable other question buttons when current widget stared recording.
        disableAllButtons();

        // Empty the array containing the previously recorded chunks.
        chunks = [];
        bytesRecordedSoFar = 0;
        if (mediaSettings.name === 'screen') {
            navigator.mediaDevices.getDisplayMedia(mediaSettings.mediaConstraints)
                .then(handleCaptureStarting)
                .catch(handleCaptureFailed);
        } else {
            navigator.mediaDevices.getUserMedia(mediaSettings.mediaConstraints)
                .then(handleCaptureStarting)
                .catch(handleCaptureFailed);
        }
    }

    /**
     * Callback once getUserMedia has permission from the user to access the recording devices.
     *
     * @param {MediaStream} stream the stream to record.
     */
    function handleCaptureStarting(stream) {
        mediaStream = stream;

        // Setup the UI for during recording.
        mediaElement.srcObject = stream;
        mediaElement.muted = true;
        if (mediaSettings.name === 'audio') {
            startSaving();
        } else {
            // Cover when user clicks Browser's "Stop Sharing Screen" button.
            if (mediaSettings.name === 'screen') {
                mediaStream.getVideoTracks()[0].addEventListener('ended', handleStopSharing);
            }
            mediaElement.play();
            mediaElement.controls = false;

            widget.dataset.state = 'starting';
            setButtonLabel('startrecording');
            widget.querySelector('.qtype_recordrtc-stop-button').disabled = false;
        }

        // Make button clickable again, to allow starting/stopping recording.
        if (pauseButton) {
            pauseButton.disabled = false;
        }
        button.disabled = false;
        button.focus();
    }

    /**
     * For recording types which show the media during recording,
     * this starts the loop-back display, but does not start recording it yet.
     */
    function startSaving() {
        // Initialize MediaRecorder events and start recording.
        mediaRecorder = new MediaRecorder(mediaStream, getRecordingOptions());

        mediaRecorder.ondataavailable = handleDataAvailable;
        mediaRecorder.onpause = handleDataAvailable;
        mediaRecorder.onstop = handleRecordingHasStopped;
        mediaRecorder.start(1000); // Capture in one-second chunks. Firefox requires that.

        widget.dataset.state = 'recording';
        // Set duration for progressbar and start animate.
        progressBar.style.animationDuration = widget.dataset.maxRecordingDuration + 's';
        progressBar.classList.add('animate');
        setButtonLabel('stoprecording');
        startCountdownTimer();
        if (mediaSettings.name === 'video' || mediaSettings.name === 'screen') {
            button.parentElement.classList.add('hide');
            controlRow.classList.remove('hide');
            controlRow.classList.add('d-flex');
            timeDisplay.classList.remove('hide');
        }
    }

    /**
     * Callback that is called by the user clicking Stop screen sharing on the browser.
     */
    function handleStopSharing() {
        if (widget.dataset.state === 'starting') {
            widget.dataset.state = 'new';
            mediaElement.parentElement.classList.add('hide');
            noMediaPlaceholder.classList.remove('hide');
            setButtonLabel('startsharescreen');
            button.blur();
        } else {
            const controlEl = widget.querySelector('.qtype_recordrtc-control-row');
            if (!controlEl.classList.contains('hide')) {
                controlEl.querySelector('.qtype_recordrtc-stop-button').click();
            }
        }
        enableAllButtons();
    }

    /**
     * Callback that is called by the media system for each Chunk of data.
     *
     * @param {BlobEvent} event
     */
    function handleDataAvailable(event) {
        if (!event.data) {
            return; // It seems this can happen around pausing.
        }

        // Check there is space to store the next chunk, and if not stop.
        bytesRecordedSoFar += event.data.size;
        if (uploadInfo.maxUploadSize >= 0 && bytesRecordedSoFar >= uploadInfo.maxUploadSize) {

            // Extra check to avoid alerting twice.
            if (!localStorage.getItem('alerted')) {
                localStorage.setItem('alerted', 'true');
                stopRecording();
                owner.showAlert('nearingmaxsize');

            } else {
                localStorage.removeItem('alerted');
            }
        }

        // Store the next chunk of data.
        chunks.push(event.data);

        // Notify form-change-checker that there is now unsaved data.
        // But, don't do this in question preview where it is just annoying.
        if (typeof M.core_formchangechecker !== 'undefined' &&
            !window.location.pathname.endsWith('/question/preview.php')) {
            M.core_formchangechecker.set_form_changed();
        }
    }

    /**
     * Pause recording.
     */
    function pause() {
        // Stop the count-down timer.
        stopCountdownTimer();
        setPauseButtonLabel('resume');
        mediaRecorder.pause();
        widget.dataset.state = 'paused';
        // Pause animate.
        toggleProgressbarState();
    }

    /**
     * Continue recording.
     */
    function resume() {
        // Stop the count-down timer.
        resumeCountdownTimer();
        widget.dataset.state = 'recording';
        setPauseButtonLabel('pause');
        mediaRecorder.resume();
        // Resume animate.
        toggleProgressbarState();
    }

    /**
     * Start recording (because the button was clicked or because we have reached a limit).
     */
    function stopRecording() {
        // Disable the button while things change.
        button.disabled = true;

        // Stop the count-down timer.
        stopCountdownTimer();

        // Update the button.
        button.classList.remove('btn-danger');
        button.classList.add('btn-outline-danger');
        if (pauseButton) {
            setPauseButtonLabel('pause');
            pauseButton.parentElement.classList.add('hide');
        }

        // Reset animation state.
        progressBar.style.animationPlayState = 'running';
        // Stop animate.
        progressBar.classList.remove('animate');

        // Ask the recording to stop.
        mediaRecorder.stop();

        // Also stop each individual MediaTrack.
        const tracks = mediaStream.getTracks();
        for (let i = 0; i < tracks.length; i++) {
            tracks[i].stop();
        }
    }

    /**
     * Callback that is called by the media system once recording has finished.
     */
    function handleRecordingHasStopped() {
        if (widget.dataset.state === 'new') {
            // This can happens if an error occurs when recording is starting. Do nothing.
            return;
        }

        // Set source of the media player.
        const blob = new Blob(chunks, {type: mediaRecorder.mimeType});
        mediaElement.srcObject = null;
        mediaElement.src = URL.createObjectURL(blob);

        // Show audio player with controls enabled, and unmute.
        mediaElement.muted = false;
        mediaElement.controls = true;
        mediaElement.parentElement.classList.remove('hide');
        noMediaPlaceholder.classList.add('hide');
        mediaElement.focus();

        if (mediaSettings.name === 'audio') {
            timeDisplay.classList.add('hide');

        } else {
            button.parentElement.classList.remove('hide');
            controlRow.classList.add('hide');
            controlRow.classList.remove('d-flex');
        }

        // Ensure the button while things change.
        button.disabled = true;
        button.classList.remove('btn-danger');
        button.classList.add('btn-outline-danger');
        widget.dataset.state = 'recorded';

        if (chunks.length > 0) {
            owner.notifyRecordingComplete(recorder);
        }
    }

    /**
     * Function that handles errors from the recorder.
     *
     * @param {DOMException} error
     */
    function handleCaptureFailed(error) {
        Log.debug('Audio/video/screen question: error received');
        Log.debug(error);

        setPlaceholderMessage('recordingfailed');
        setButtonLabel('recordagainx');
        button.classList.remove('btn-danger');
        button.classList.add('btn-outline-danger');
        widget.dataset.state = 'new';
        // Hide time display.
        timeDisplay.classList.add('hide');

        if (mediaRecorder && mediaRecorder.state !== 'inactive') {
            mediaRecorder.stop();
        }

        // Changes 'CertainError' -> 'gumcertain' to match language string names.
        const stringName = 'gum' + error.name.replace('Error', '').toLowerCase();

        owner.showAlert(stringName);
        enableAllButtons();
    }

    /**
     * Start the countdown timer.
     */
    function startCountdownTimer() {
        timeRemaining = widget.dataset.maxRecordingDuration * 1000;
        resumeCountdownTimer();
        updateTimerDisplay();
    }

    /**
     * Stop the countdown timer.
     */
    function stopCountdownTimer() {
        timeRemaining = stopTime - Date.now();
        if (countdownTicker !== 0) {
            clearInterval(countdownTicker);
            countdownTicker = 0;
        }
    }

    /**
     * Start or resume the countdown timer.
     */
    function resumeCountdownTimer() {
        stopTime = Date.now() + timeRemaining;
        if (countdownTicker === 0) {
            countdownTicker = setInterval(updateTimerDisplay, 100);
        }
    }

    /**
     * Update the countdown timer, and stop recording if we have reached 0.
     */
    function updateTimerDisplay() {
        const millisecondsRemaining = stopTime - Date.now();
        const secondsRemaining = Math.round(millisecondsRemaining / 1000);
        const secondsStart = widget.dataset.maxRecordingDuration - secondsRemaining;
        // Set time label for elements.
        setLabelForTimer(secondsStart, secondsRemaining);
        if (millisecondsRemaining <= 0) {
            stopRecording();
        }
    }

    /**
     * Get time label for timer.
     *
     * @param {number} seconds The time in seconds.
     * @return {string} The label for timer. e.g. '00:00' or '10:00'.
     */
    function getTimeLabelForTimer(seconds) {
        const secs = seconds % 60;
        const mins = Math.round((seconds - secs) / 60);

        return M.util.get_string('timedisplay', 'qtype_recordrtc',
            {mins: pad(mins), secs: pad(secs)});
    }

    /**
     * Set time label for timer.
     * We need to update the labels for both the timer back(whose background color is white) and
     * timer front (with blue background) to create a text effect that contrasts with the background color.
     *
     * @param {Number} secondsStart The second start. e.g: With duration 1 minute
     * secondsStart will start from 0 and increase up to 60.
     * @param {Number} secondsRemaining The second remaining. e.g: With duration 1 minute
     * secondsRemaining will decrease from 60 to 0.
     */
    function setLabelForTimer(secondsStart, secondsRemaining) {
        // Set time label for timer back.
        backTimeEnd.innerText = getTimeLabelForTimer(secondsRemaining);
        backtimeStart.innerText = getTimeLabelForTimer(secondsStart);
        // Set time label for timer front.
        frontTimeEnd.innerText = getTimeLabelForTimer(secondsRemaining);
        fronttimeStart.innerText = getTimeLabelForTimer(secondsStart);
    }

    /**
     * Zero-pad a string to be at least two characters long.
     *
     * @param {number} val e.g. 1 or 10
     * @return {string} e.g. '01' or '10'.
     */
    function pad(val) {
        const valString = val + '';

        if (valString.length < 2) {
            return '0' + valString;
        } else {
            return '' + valString;
        }
    }

    /**
     * Trigger the upload of the recorded media back to Moodle.
     */
    function uploadMediaToServer() {
        setButtonLabel('uploadpreparing');

        // First we need to get the media data from the media element.
        const fetchRequest = new XMLHttpRequest();
        fetchRequest.open('GET', mediaElement.src);
        fetchRequest.responseType = 'blob';
        fetchRequest.addEventListener('load', handleRecordingFetched);
        fetchRequest.send();
    }

    /**
     * Callback called once we have the data from the media element, ready to upload to Moodle.
     *
     * @param {ProgressEvent} e
     */
    function handleRecordingFetched(e) {
        const fetchRequest = e.target;
        if (fetchRequest.status !== 200) {
            // No data.
            return;
        }

        // Blob is now the media that the audio/video tag's src pointed to.
        const blob = fetchRequest.response;

        // Create FormData to send to PHP filepicker-upload script.
        const formData = new FormData();
        formData.append('repo_upload_file', blob, widget.dataset.recordingFilename);
        formData.append('sesskey', M.cfg.sesskey);
        formData.append('repo_id', uploadInfo.uploadRepositoryId);
        formData.append('itemid', uploadInfo.draftItemId);
        formData.append('savepath', '/');
        formData.append('ctx_id', uploadInfo.contextId);
        formData.append('overwrite', '1');

        const uploadRequest = new XMLHttpRequest();
        uploadRequest.addEventListener('readystatechange', handleUploadReadyStateChanged);
        uploadRequest.upload.addEventListener('progress', handleUploadProgress);
        uploadRequest.addEventListener('error', handleUploadError);
        uploadRequest.addEventListener('abort', handleUploadAbort);
        uploadRequest.open('POST', M.cfg.wwwroot + '/repository/repository_ajax.php?action=upload');
        uploadRequest.send(formData);
    }

    /**
     * Callback for when the upload completes.
     * @param {ProgressEvent} e
     */
    function handleUploadReadyStateChanged(e) {
        const uploadRequest = e.target;
        if (uploadRequest.readyState !== 4) {
            return; // Not finished yet. We will get more of these events when it is.
        }

        const response = JSON.parse(uploadRequest.responseText);
        if (response.errorcode) {
            handleUploadError(); // Moodle sends back errors with a 200 status code for some reason!
        }

        if (uploadRequest.status === 200) {
            // When request finished and successful.
            setButtonLabel('recordagainx');
            button.classList.remove('btn-outline-danger');
            enableAllButtons();
        } else if (uploadRequest.status === 404) {
            setPlaceholderMessage('uploadfailed404');
            enableAllButtons();
        }
    }

    /**
     * Callback for updating the upload progress.
     * @param {ProgressEvent} e
     */
    function handleUploadProgress(e) {
        setButtonLabel('uploadprogress', Math.round(e.loaded / e.total * 100) + '%');
    }

    /**
     * Callback for when the upload fails with an error.
     */
    function handleUploadError() {
        setPlaceholderMessage('uploadfailed');
        enableAllButtons();
    }

    /**
     * Callback for when the upload fails with an error.
     */
    function handleUploadAbort() {
        setPlaceholderMessage('uploadaborted');
        enableAllButtons();
    }

    /**
     * Display a progress message in the upload progress area.
     *
     * @param {string} langString
     * @param {string|null} [a] optional variable to populate placeholder with
     */
    function setButtonLabel(langString, a) {
        if (!a) {
            // Seemingly unnecessary space inside the span is needed for screen-readers, and it must be a non-breaking space.
            a = '<span class="sr-only">&nbsp;' + widget.dataset.widgetName + '</span>';
        }
        button.innerHTML = M.util.get_string(langString, 'qtype_recordrtc', a);
    }

    /**
     * Display a progress message in the upload progress area.
     *
     * @param {string} langString
     */
    function setPauseButtonLabel(langString) {
        pauseButton.innerText = M.util.get_string(langString, 'qtype_recordrtc');
    }

    /**
     * Display a message in the upload progress area.
     *
     * @param {string} langString
     */
    function setPlaceholderMessage(langString) {
        noMediaPlaceholder.textContent = M.util.get_string(langString, 'qtype_recordrtc');
        mediaElement.parentElement.classList.add('hide');
        noMediaPlaceholder.classList.remove('hide');
    }

    /**
     * Select best options for the recording codec.
     *
     * @returns {Object}
     */
    function getRecordingOptions() {
        const options = {};

        // Get the relevant bit rates from settings.
        if (mediaSettings.name === 'audio') {
            options.audioBitsPerSecond = mediaSettings.bitRate;
        } else if (mediaSettings.name === 'video' || mediaSettings.name === 'screen') {
            options.videoBitsPerSecond = mediaSettings.bitRate;
            options.videoWidth = mediaSettings.width;
            options.videoHeight = mediaSettings.height;

            // Go through our list of mimeTypes, and take the first one that will work.
            for (let i = 0; i < mediaSettings.mimeTypes.length; i++) {
                if (MediaRecorder.isTypeSupported(mediaSettings.mimeTypes[i])) {
                    options.mimeType = mediaSettings.mimeTypes[i];
                    break;
                }
            }
        }

        return options;
    }

    /**
     * Enable all buttons in the question.
     */
    function enableAllButtons() {
        disableOrEnableButtons(true);
        owner.notifyButtonStatesChanged();
    }

    /**
     * Disable all buttons in the question.
     */
    function disableAllButtons() {
        disableOrEnableButtons(false);
    }

    /**
     * Disables/enables other question buttons when current widget started recording/finished recording.
     *
     * @param {boolean} enabled true if the button should be enabled.
     */
    function disableOrEnableButtons(enabled = false) {
        widget.closest('.que').querySelectorAll('button, input[type=submit], input[type=button]').forEach(
            function(button) {
                button.disabled = !enabled;
            }
        );
    }

    /**
     * Pause/resume the progressbar state.
     */
    function toggleProgressbarState() {
        const running = progressBar.style.animationPlayState || 'running';
        progressBar.style.animationPlayState = running === 'running' ? 'paused' : 'running';
    }
}

/**
 * Object that controls the settings for recording audio.
 *
 * @param {string} bitRate desired audio bitrate.
 * @constructor
 */
function AudioSettings(bitRate) {
    this.name = 'audio';
    this.bitRate = parseInt(bitRate, 10);
    this.mediaConstraints = {
        audio: true
    };
    this.mimeTypes = [
        'audio/webm;codecs=opus',
        'audio/ogg;codecs=opus'
    ];
}

/**
 * Object that controls the settings for recording video.
 *
 * @param {string} bitRate desired video bitrate.
 * @param {string} width desired width.
 * @param {string} height desired height.
 * @constructor
 */
function VideoSettings(bitRate, width, height) {
    this.name = 'video';
    this.bitRate = parseInt(bitRate, 10);
    this.width = parseInt(width, 10);
    this.height = parseInt(height, 10);
    this.mediaConstraints = {
        audio: true,
        video: {
            width: {ideal: this.width},
            height: {ideal: this.height}
        }
    };
    this.mimeTypes = [
        'video/webm;codecs=vp9,opus',
        'video/webm;codecs=h264,opus',
        'video/webm;codecs=vp8,opus'
    ];
}

/**
 * Object that controls the settings for recording screen.
 *
 * @param {string} bitRate desired screen bitrate.
 * @param {string} width desired width.
 * @param {string} height desired height.
 * @constructor
 */
function ScreenSettings(bitRate, width, height) {
    this.name = 'screen';
    this.bitRate = parseInt(bitRate, 10);
    this.width = parseInt(width, 10);
    this.height = parseInt(height, 10);
    this.mediaConstraints = {
        audio: true,
        systemAudio: 'exclude',
        video: {
            displaySurface: 'monitor',
            frameRate: {ideal: 24},
            // Currently, Safari does not support ideal constraints for width and height with screen sharing feature.
            // It may be supported in version 16.4.
            width: {max: this.width},
            height: {max: this.height},
        }
    };

    // We use vp8 as the default codec. If it is not supported, we will switch to another codec.
    this.mimeTypes = [
        'video/webm;codecs=vp8,opus',
        'video/webm;codecs=vp9,opus',
        'video/webm;codecs=h264,opus',
    ];
}

/**
 * Represents one record audio or video question.
 *
 * @param {string} questionId id of the outer question div.
 * @param {Object} settings like audio bit rate.
 * @constructor
 */
function RecordRtcQuestion(questionId, settings) {
    const questionDiv = document.getElementById(questionId);

    // Check if the RTC API can work here.
    const result = checkCanWork();
    if (result === 'nothttps') {
        questionDiv.querySelector('.https-warning').classList.remove('hide');
        return;
    } else if (result === 'nowebrtc') {
        questionDiv.querySelector('.no-webrtc-warning').classList.remove('hide');
        return;
    }

    // Make the callback functions available.
    this.showAlert = showAlert;
    this.notifyRecordingComplete = notifyRecordingComplete;
    this.notifyButtonStatesChanged = setSubmitButtonState;
    const thisQuestion = this;

    // We may have more than one widget in a question.
    questionDiv.querySelectorAll('.qtype_recordrtc-audio-widget, .qtype_recordrtc-video-widget, .qtype_recordrtc-screen-widget')
        .forEach(function(widget) {
            // Get the appropriate options.
            let typeInfo;
            switch (widget.dataset.mediaType) {
                case 'audio':
                    typeInfo = new AudioSettings(settings.audioBitRate);
                    break;
                case 'screen':
                    typeInfo = new ScreenSettings(settings.screenBitRate, settings.screenWidth, settings.screenHeight);
                    break;
                default:
                    typeInfo = new VideoSettings(settings.videoBitRate, settings.videoWidth, settings.videoHeight);
                    break;
            }

            // Create the recorder.
            new Recorder(widget, typeInfo, thisQuestion, settings);
            return 'Not used';
        });
    setSubmitButtonState();

    /**
     * Set the state of the question's submit button.
     *
     * If any recorder does not yet have a recording, then disable the button.
     * Otherwise, enable it.
     */
    function setSubmitButtonState() {
        let anyRecorded = false;
        questionDiv.querySelectorAll('.qtype_recordrtc-audio-widget, .qtype_recordrtc-video-widget, .qtype_recordrtc-screen-widget')
            .forEach(function(widget) {
                if (widget.dataset.state === 'recorded') {
                    anyRecorded = true;
                }
            });
        const submitButton = questionDiv.querySelector('input.submit[type=submit]');
        if (submitButton) {
            submitButton.disabled = !anyRecorded;
        }
    }

    /**
     * Show a modal alert.
     *
     * @param {string} subject Subject is the content of the alert (which error the alert is for).
     * @return {Promise}
     */
    function showAlert(subject) {
        return ModalFactory.create({
            type: ModalFactory.types.ALERT,
            title: M.util.get_string(subject + '_title', 'qtype_recordrtc'),
            body: M.util.get_string(subject, 'qtype_recordrtc'),
        }).then(function(modal) {
            modal.show();
            return modal;
        });
    }

    /**
     * Callback called when the recording is completed.
     *
     * @param {Recorder} recorder the recorder.
     */
    function notifyRecordingComplete(recorder) {
        recorder.uploadMediaToServer();
    }
}

/**
 * Initialise a record audio or video question.
 *
 * @param {string} questionId id of the outer question div.
 * @param {Object} settings like audio bit rate.
 */
function init(questionId, settings) {
    M.util.js_pending('init-' + questionId);
    new RecordRtcQuestion(questionId, settings);
    M.util.js_complete('init-' + questionId);
}

export {
    init
};
