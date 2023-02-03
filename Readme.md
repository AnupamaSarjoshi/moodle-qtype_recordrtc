# Record audio and video question type

This question type is like the standard essay question type, but instead
of writing some text, students have one or more recording widgets where
they can record some audio or video. Like the standard essay question type,
it is not automatically graded.


## Installation

### Install from the plugins database

Install from the Moodle plugins database https://moodle.org/plugins/qtype_recordrtc
in the normal way.

### Install using git

Or you can install using git. Type this commands in the root of your Moodle install

    git clone https://github.com/moodleou/moodle-qtype_recordrtc.git question/type/recordrtc
    echo /question/type/recordrtc/ >> .git/info/exclude

Then run the moodle update process
Site administration > Notifications

### Setup

On the admin screens, there are a few settings you may wish to change, for example
audio and video quality and the maximum recording length.
