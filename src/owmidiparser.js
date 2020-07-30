/*
Reads a MIDI object created by Tonejs/Midi and converts it to an Overwatch workshop array.
*/


"use strict";

// Range of notes on the overwatch piano, 
// based on the MIDI scale (0 - 127).
// One integer is one semitone.
const PIANO_RANGE = Object.freeze({
    MIN: 24,
    MAX: 88
});
const OCTAVE = 12;

/* Settings for the parsing the midi data.
    - startTime: time (seconds) in the midi file when this script begins reading the data
    - voices: amount of bots required to play the resulting script, maximum amount of pitches allowed in any chord.
              At least 6 recommended to make sure all songs play back reasonably well
*/
const CONVERTER_SETTINGS_INFO = Object.freeze({
    startTime:	{MIN:0, MAX:Infinity,   DEFAULT:0},
    voices:		{MIN:6, MAX:11,         DEFAULT:6},
});

const DEFAULT_SETTINGS = {
    startTime:	CONVERTER_SETTINGS_INFO["startTime"]["DEFAULT"],
    voices:		CONVERTER_SETTINGS_INFO["voices"]["DEFAULT"],
};

// Maximum amount of elements in a single array of the song data rules.
// Overwatch arrays are limited to 999 elements per dimension.
const MAX_OW_ARRAY_SIZE = 999;

// The workshop script has a maximum Total Element Count (TEC) of 20 000, 
// which depends on not just the amount of rules and actions but also their complexity.
// This value is the maximum amount of *array* elements (not related to TEC) allowed in all song data rules.
// Determined with trial and error, and contains some leeway for adding more actions to the base script later on.
const MAX_TOTAL_ARRAY_ELEMENTS = 9000;

// Amount of decimals in the time of each note
const NOTE_PRECISION = 3;


// Maximum time interval (milliseconds) between two chords
const MAX_TIME_INTERVAL = 9999;

const CONVERTER_WARNINGS = {
    TYPE_0_FILE: "WARNING: The processed file is a type 0 file and may have been converted incorrectly.\n"
};

const CONVERTER_ERRORS = {
    NO_NOTES_FOUND: `Error: no notes found in MIDI file in the given time range.\n`
};

// Lengths (in digits) of song data elements when compression is used.
const SONG_DATA_ELEMENT_LENGTHS = {
    pitchArrays: 2,
    timeArrays: 4,
    chordArrays: 1
};

// Maximum length (in digits) of a compressed array element. See the compressSongArrays function for more info. 
const COMPRESSED_ELEMENT_LENGTH = 7;


function convertMidi(mid, settings={}, compressionEnabled=true) {
    /*
    param mid:  a Midi object created by Tonejs/Midi
    param settings: a JS object containing user parameters for 
                    parsing the midi data, see DEFAULT_SETTINGS for an example

    Return: a JS object, containing:
        string rules:           Overwatch workshop rules containing the song Data,
                                or an empty string if an error occurred
        int transposedNotes:    Amount of notes transposed to the range of the Overwatch piano
        int skippedNotes:       Amount of notes skipped due to there being too many pitches in a chord
        float duration:         Full duration (seconds) of the MIDI song 
        float stopTime:         The time (seconds) when the script stopped reading the MIDI file, 
                                either due to finishing the song or due to reaching the maximum allowed amount of data 
        string[] warnings:      An array containing warnings output by the script
        string[] errors:        An array containing errors output by the script
    */

    if (Object.keys(settings).length != Object.keys(CONVERTER_SETTINGS_INFO).length) {
        settings = DEFAULT_SETTINGS;
    }

    let midiInfo = readMidiData(mid, settings);
    let rules = "";

    let arrayInfo = {};
    if (midiInfo.chords.size != 0) {
        arrayInfo = convertToArray(midiInfo.chords, compressionEnabled);

        if (compressionEnabled) {
            arrayInfo.owArrays = compressSongArrays(arrayInfo.owArrays);
        }

        rules = writeWorkshopRules(arrayInfo.owArrays, settings["voices"]);
    }
    
    return { 
        rules:              rules, 
        skippedNotes:       midiInfo.skippedNotes, 
        transposedNotes:    midiInfo.transposedNotes,
        duration:           mid.duration,
        stopTime:           arrayInfo.stopTime,
        warnings:           midiInfo.warnings,
        errors:             midiInfo.errors
    };
}


function readMidiData(mid, settings) {
    // Reads the contents of a Midi object (generated by Tonejs/Midi)
    // to a map with times (float) of chords as keys 
    // and pitches (array of ints) in those chords as values

    let chords = new Map();

    let skippedNotes = 0;
    let transposedNotes = 0;

    for (let track of mid.tracks) {
        if (track.channel == 9) {
            // Percussion channel, ignore track
            continue;
        }
        
        for (let note of track.notes) {
            if (note.velocity == 0) {
                // Note off event, not used by the Overwatch piano
                continue;
            }
            if (note.time < settings["startTime"]) {
                continue;
            }

            let notePitch = note.midi;
            if (notePitch < PIANO_RANGE["MIN"] || notePitch > PIANO_RANGE["MAX"]) {
                transposedNotes += 1
                notePitch = transposePitch(notePitch);
            }

            notePitch -= PIANO_RANGE["MIN"];
            let noteTime = roundToPlaces(note.time, NOTE_PRECISION);

            if (chords.has(noteTime)) {
                if (!chords.get(noteTime).includes(notePitch)) {

                    if (chords.get(noteTime).length < settings["voices"]) {
                        chords.get(noteTime).push(notePitch);
                    } else {
                        skippedNotes += 1;
                    }
                }
            } else {
                chords.set( noteTime, [notePitch] );
            }
        }
    }

    let warnings = [];
    let errors = [];

    if (chords.size == 0) {
        errors.push(CONVERTER_ERRORS["NO_NOTES_FOUND"]);
    } else {
        // Sort by keys (times)
        chords = new Map([...chords.entries()].sort( (time1, time2) => 
                                                    { return roundToPlaces(parseFloat(time1) 
                                                      - parseFloat(time2), NOTE_PRECISION) } ));
    }

    if (mid.tracks.length == 1) {
        // Type 0 midi files have only one track
        warnings.push(CONVERTER_WARNINGS["TYPE_0_FILE"]);
    }

    return { 
        chords, 
        skippedNotes, 
        transposedNotes, 
        warnings, 
        errors 
    };
}


function convertToArray(chords, compressionEnabled) {
    // Converts the contents of the chords map 
    // to a format compatible with Overwatch

    let owArrays = {
        pitchArrays: [],
        timeArrays: [],
        chordArrays: []
    };

    let pitchArrayElements = 0;
    let timeArrayElements = 0;
    let chordArrayElements = 0;

    // Size measured by amount of array elements used
    let uncompressedSize = 0;
    let compressedSize = 0;

    // Time of the first note
    let prevTime = chords.keys().next().value;
    
    let stopTime = 0;
    for (let [currentChordTime, pitches] of chords.entries()) {

        pitchArrayElements += pitches.length;
        timeArrayElements += 1;
        chordArrayElements += 1;

        uncompressedSize = pitchArrayElements + timeArrayElements + chordArrayElements;
        compressedSize = Math.ceil(
                                   (pitchArrayElements * SONG_DATA_ELEMENT_LENGTHS["pitchArrays"]
                                    + timeArrayElements * SONG_DATA_ELEMENT_LENGTHS["timeArrays"]
                                    + chordArrayElements * SONG_DATA_ELEMENT_LENGTHS["chordArrays"]
                                    )
                                   / COMPRESSED_ELEMENT_LENGTH);

        if ( (compressionEnabled ? compressedSize : uncompressedSize) > MAX_TOTAL_ARRAY_ELEMENTS) {
            // Maximum amount of elements reached, stop adding 
            stopTime = currentChordTime;
            break;
        }

        // One chord in the song consists of 
        // A) the time interval (milliseconds) between current chord and previous chord
        owArrays["timeArrays"].push(Math.min(roundToPlaces((currentChordTime - prevTime) * 1000, NOTE_PRECISION), MAX_TIME_INTERVAL));
        // B) the amount of pitches in the chord
        owArrays["chordArrays"].push(pitches.length);
        // and C) the pitches themselves 
        for (let newPitch of pitches.sort()) {
            owArrays["pitchArrays"].push( newPitch );
        }

        prevTime = currentChordTime;
    }

    if (stopTime == 0) {
        // The entire song was added,
        // set stoptime to be the time of the last chord/note in the song
        stopTime = Array.from( chords.keys() )[chords.size - 1];
    }
    console.log(compressedSize);

    return { owArrays, stopTime };
}


function compressSongArrays(owArrays) {
    /*
    Compresses the song arrays by clumping several elements into one integer. For example:
    (maxElementLength = 3)
    Data:               Array(12, 0, 312, 2, 56, 23, 23, 4, 153, 123, 110 ...)
    Compressed data:    Array(0120003, 1200205, 6023023, 0041531, 23110...)

    Total Element Count (TEC) is the limit to how much data can be pasted into the workshop prior to starting the custom game.
    The amount of data generated during runtime (by e.g. decompression) is far less limited.
    
    When pasting integers into the workshop, the increase in TEC is only affected by 
    the amount of integers, not their individual sizes. String arrays could be used for far better efficiency instead of integer arrays, 
    but there is no straightforward way to read them with workshop due to lack of simple string methods. 
    Up to 7 digits can be used per integer while still maintaining accuracy.

    Things to look into later: delta encoding/compression
    */

    let compressedArrays = {
        pitchArrays: [],
        timeArrays: [],
        chordArrays: []
    };

    for (let [arrayName, songArray] of Object.entries(owArrays)) {
        // Prepend with zeroes if an element is not long enough
        songArray = songArray.map(x => x.toString().padStart(SONG_DATA_ELEMENT_LENGTHS[arrayName], "0"));

        let stringBuffer = songArray.join("");

        // Write to compressedArray 7 numbers at a time
        for (let i = 0; i < stringBuffer.length; i += COMPRESSED_ELEMENT_LENGTH) {

            let newElement = stringBuffer.slice(i, i + COMPRESSED_ELEMENT_LENGTH);
            compressedArrays[arrayName].push(newElement);
        }
    }
    console.log(compressedArrays);
    
    return compressedArrays;
}


function writeWorkshopRules(owArrays, maxVoices) {
    // Creates workshop rules containing the song data in arrays, 
    // ready to be pasted into Overwatch
    
    let rules = [`rule(\"Max amount of bots required\"){event{Ongoing-Global;}` +
    `actions{Global.maxBots = ${maxVoices};Global.maxArraySize = ${MAX_OW_ARRAY_SIZE};
    Global.compressedElementSize = ${COMPRESSED_ELEMENT_LENGTH};}}\n`];

    // Write all 3 arrays in owArrays to workshop rules
    for (let [arrayName, songArray] of Object.entries(owArrays)) {

        // Index of the current overwatch array being written to
        let owArrayIndex = 0;

        // Index of the current JS array element being written
        let index = 0;
        while (index < songArray.length) {

            let actions = `Global.${arrayName}[${owArrayIndex}] = Array(${songArray[index]}`;
            index += 1;
            
            // Write 998 elements at a time to avoid going over the array size limit 
            for (let j = 0; j < MAX_OW_ARRAY_SIZE - 1; j++) {
                actions += `, ${songArray[index]}`;
                index += 1;

                if (index >= songArray.length) {
                    break;
                }
            }

            let newRule = `rule(\"${arrayName}\"){event{Ongoing-Global;}` +
                          `actions{${actions});}}\n`;       
            rules.push(newRule);
            owArrayIndex += 1;
        }
    }

    return rules.join("");
}


function transposePitch(pitch) {
    while (pitch < PIANO_RANGE["MIN"]) {
        pitch += OCTAVE;
    }
    while (pitch > PIANO_RANGE["MAX"]) {
        pitch -= OCTAVE;
    }
    return pitch;
}

function roundToPlaces(value, decimalPlaces) {
    return Math.round(value * Math.pow(10, decimalPlaces)) / Math.pow(10, decimalPlaces);
}
