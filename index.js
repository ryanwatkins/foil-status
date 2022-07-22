const fs = require('fs').promises
const d3 = require('d3')
const axios = require('axios').default
const Handlebars = require('handlebars')

require('dotenv').config()

let officersByKey = new Map() // map of officers by name/shield to unique_mos
let mapping = {} // officer and complaint data
let report = {
  summary: {},
  officers: [],
  foils: [],
} // data for report html generation

// for an officer in the spreadsheet,
// find corresponding officer object in cache
function findOfficer(record) {
  // manually match where records are not consistent
  // ex. name changed, made LT+ rank, etc
  const manualMatch = {
    'STEVENS:ANTHONY:25283': '73109',
    'SHEPPARD:TARIK:0': '31361',
    'ORTIZ:STEVEN:0': '61403',
    'OCONNELL:JOHN:0': '1635',
    'MERVIN:BENNET:0': '6232',
    'MCCARTHY:JAMES:0': '61824',
    'LEE:JAMES:0': '1587',
    'GALLAGHER:WILLIAM:0': '35669',
    'ALEXANDER:BRIAN:0': '19707',
    'BUTLER:MICHAEL:0': '34930',
    'HENDERSON:ROBERT:0': '80598',
  }

  const key = `${record.last_name}:${record.first_name}:${record.shield_no}`
  if (manualMatch[key]) {
    return mapping.officers[manualMatch[key]]
  }

  const found = officersByKey.get(key)
  if (found?.length !== 1) {
    console.error('ERROR - cant find officer', record, found)
    return
  }

  return mapping.officers[found[0]]
}

// given a complaint, identify if any allegations are pending an APU trial
function isComplaintPending(complaint) {
  const pending = complaint.allegations.filter(allegation => {
    return allegation.nypd_disposition?.match('Decision Pending')
  })
  return Boolean(pending.length)
}

// load google drive and get list complaint closing reports we've
// obtained based on filename
async function loadReports() {
  if (!process.env.DRIVE_API_KEY) {
    console.error('no DRIVE_API_KEY defined, cannot load reports.  set in .env or environment variable')
    process.exit()
  }

  const response = await axios(`https://www.googleapis.com/drive/v3/files?q='1GiTvSKGMh--3llPxYJq_qIbTlPk-O7Z2'+in+parents&key=${process.env.DRIVE_API_KEY}&pageSize=1000`)
  const data = response.data

  let reports = []

  // assume all reports are stored <foil id>/<complaint id>*.pdf
  // this will be incorrect for  nested folders
  // and non-report PDF that start with a digit
  const folders = data?.files.filter(folder => {
    if (folder.mimeType !== 'application/vnd.google-apps.folder') return false
    return true
  })

  for await (const folder of folders) {
    // const FOIL_ID = folder.id
    const response = await axios(`https://www.googleapis.com/drive/v3/files?q='${folder.id}'+in+parents&key=${process.env.DRIVE_API_KEY}&pageSize=1000`)
    const data = response.data

    const files = data.files.filter(file => {
      if (!file.name.endsWith('.pdf')) return false
      if (!file.name.match(/^(\d*)(.*)\.pdf/)?.[1]) return false
      return true
    })

    files.forEach(file => {
      reports.push({
        folder_foil_id: folder.name,
        complaint_id: file.name.match(/^(\d*)(.*).*\.pdf/)?.[1],
      })
    })
  }

  return reports
}

// load google sheet of officers, filter to ones that have been FOILed
// find any provided FOIL id and also find the officer in the lookup table
async function loadRequests() {
  const response = await axios(`https://docs.google.com/spreadsheets/d/1VoCHoMXiR5OHhoYrwaIJxGPwKiLpYT8et3fux13cfGo/export?format=csv&gid=1431660392`)
  const data = response.data

  let records = await d3.csvParse(data, function(entry) {
    return {
      first_name: entry['first_name'],
      last_name: entry['last_name'],
      rank: entry['rank'],
      command: entry['command'],
      shield_no: entry['shield_no'],
      requester: entry['Requester'],
      deadline_date: entry['CCRB Response Deadline'],
      received_date: entry['Received'],
      submitted_date: entry['Submitted Date'],
      foil_id: entry['FOIL Id'],
    }
  })

  records = records.filter(record => record.requester || record.foil_id)

  let foils = {}

  records.forEach(record => {
    const foil_id = record.foil_id || 'BLANK' // we dont have a FOIL ID for all our requests in the spreadsheet
    const officer = findOfficer(record)

    if (!foils[foil_id]) {
      foils[foil_id] = {
        foil_id,
        officers: [],
        submitted_date: record.submitted_date,
        deadline_date: record.deadline_date
      }
    }
    if (officer) {
      foils[foil_id].officers.push(officer.unique_mos)
    }
  })

  foils = Object.values(foils).sort((a,b) => {
    if (a.foil_id == 'BLANK') return 1
    if (b.foil_id == 'BLANK') return -1
    if (a.foil_id > b.foil_id) return 1
    if (a.foil_id < b.foil_id) return -1
    return 0
  })

  let officers = new Set()
  records.forEach(record => {
    const officer = findOfficer(record)
    if (officer) {
      officers.add(officer.unique_mos)
    } else {
      console.error('could not find officer:', record)
    }
  })

  return {
    foils,
    officers: Array.from(officers)
  }
}

// gets the status of reports received for all of the officers complaints
function getOfficerStatus({ officers, receivedReports }) {
  let response = officers.map(officer => mapping.officers[officer])
  response.sort((a,b) => {
    if (a.last_name > b.last_name) return 1
    if (a.last_name < b.last_name) return -1
    if (a.first_name > b.first_name) return 1
    if (a.first_name < b.first_name) return -1
    return 0
  })

  response = response.map(officer => {
    return {
      ...officer,
      complaints: getComplaintsStatus({ complaints: officer.complaints, receivedReports })
    }
  })

  return response
}

// show the status of reports received for all officers in that FOIL request
function getFOILStatus({ foils, receivedReports }) {
  let response = foils.map(foil => {
    let complaints = new Set()
    let officers = foil.officers.map(id => {
      let officer = mapping.officers[id]
      officer.complaints.forEach(id => complaints.add(id))
      return mapping.officers[id]
    })

    return {
      foil_id: foil.foil_id,
      officers,
      complaints: getComplaintsStatus({ complaints: complaints, receivedReports })
    }
  })

  return response
}

// get the status of a set of complaints:
// received, waiting, if pending APU, if we have all of them
function getComplaintsStatus({ complaints, receivedReports }) {
  const reportIds = receivedReports.map(r => r.complaint_id)

  let response = {}

  response.all = Array.from(complaints).sort((a,b) => {
    return parseInt(b, 10) - parseInt(a, 10)
  }).map(complaint_id => {
    const complaint = mapping.complaints[complaint_id]
    return {
      complaint_id: complaint_id,
      received: reportIds.includes(complaint_id),
      pending: isComplaintPending(complaint),
      complaint
    }
  })

  response.received = response.all.filter(c => c.received)
  response.waiting = response.all.filter(c => !c.received)
  response.completed = Boolean(response.waiting.length === 0)

  return response
}

// build a lookup table to match officers from spreadsheet by name/shield
function generateOfficersByKey() {
  Object.values(mapping.officers).forEach(officer => {
    let keys = [`${officer.last_name}:${officer.first_name}:${officer.shield_no || 0}`.toUpperCase()]

    if (officer.shield_no_history) {
      officer.shield_no_history.forEach(shield_no => {
        keys.push(`${officer.last_name}:${officer.first_name}:${shield_no || 0}`.toUpperCase())
      })
    }

    keys.forEach(key => {
      if (officersByKey.has(key)) {
        officersByKey.set(key, [...officersByKey.get(key), officer.unique_mos])
      } else {
        officersByKey.set(key, [officer.unique_mos])
      }
    })
  })
}

async function buildReportHtml() {
  const source = await fs.readFile('report.hbs')
  const template = Handlebars.compile(source.toString())
  const result = template(report)

  await fs.writeFile('report.html', result)
}

async function start() {
  // load officers and complaint db, and generate an index of officers by name/shield
  let json = await fs.readFile('foil-status-mapping.json')
  mapping = JSON.parse(json)
  generateOfficersByKey()

  const receivedReports = await loadReports() // received pdf closing reports
  let { foils, officers } = await loadRequests() // FOIL requests and officer ids
  const foilIds = Array.from(new Set(foils.map(o => o.foil_id))) // foil ids for foils

  let complaints = []
  officers.forEach(officer => {
    if (!mapping.officers[officer]) return
    complaints = [...complaints, ...mapping.officers[officer].complaints]
  })
  complaints = Array.from(new Set(complaints))

  const remainingReports = complaints.filter(complaint => !receivedReports.map(r => r.complaint_id).includes(complaint))
  const complaintsPending = remainingReports.filter(complaint => isComplaintPending(mapping.complaints[complaint]))

  // summary info
  console.log('Officers requested:', officers.length)
  console.log('Complaints for officers requested:', complaints.length)
  console.log('Complaints for officers remaining:', remainingReports.length)
  console.log('Complaints remaining, pending APU decision:', complaintsPending.length)
  console.log('Complaint Closing Reports received:', receivedReports.length) // we have reports we did not request from other sources
  console.log('FOIL requests:', foilIds.length)

  report.summary = {
    officers: officers.length,
    requested: complaints.length,
    remaining: remainingReports.length,
    pending: complaintsPending.length,
    received: receivedReports.length,
    foils: foilIds.length
  }

  // per officer, per FOIL info
  report.officers = getOfficerStatus({ officers, receivedReports })
  report.foils = getFOILStatus({ foils, receivedReports })

  // await fs.writeFile('report.json', JSON.stringify(report, null, 2))
  // json = await fs.readFile('report.json')
  // report = JSON.parse(json)

  await buildReportHtml()
}

start()
