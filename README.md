# FOIL status of CCRB Closing Report Project

Loads data from Google Sheet and Google Drive to track the status of
reports received and reports still waiting on, by Officer and by FOIL
request.

## Setup

Create .env file with your Google API key (https://console.cloud.google.com/apis/credentials).  This is used to load the reports from Google Drive.

```
DRIVE_API_KEY="<key value>"
```

Install depencies and run report.

```
yarn install
yarn start
```
