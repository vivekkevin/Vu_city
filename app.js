require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const sharp = require('sharp');
const multer = require('multer');
const bodyParser = require('body-parser');
const app = express();
const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');

app.set('view engine', 'ejs');
app.set('views', './views');

// Connect to MongoDB Atlas
mongoose.connect(process.env.MONGO_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true
})
.then(() => console.log("MongoDB connected successfully"))
.catch(err => console.error("MongoDB connection error:", err));

// MongoDB schema definition
const imageDataSchema = new mongoose.Schema({
    tileNumber: String,
    errorComments: String,
    errorType: String,
    buildingNumber: String,
    thumbnails: {
        qcError: String,
        mError: String,
        corrected: String
    },
    fullImages: {
        qcError: String,
        mError: String,
        corrected: String
    },
    approvalStatus: { type: String, default: "Pending" }
});

const ImageData = mongoose.model('ImageData', imageDataSchema);

app.use(express.urlencoded({ extended: true }));
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());

// Multer configuration for file uploads
const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

// Function to process and resize images
async function processImages(files) {
    const options = { quality: 80, compressionLevel: 6 };
    const images = {};

    if (files['qcError']) {
        images.qcErrorThumbnail = await sharp(files['qcError'][0].buffer)
            .resize(250, 250, { fit: 'fill' })
            .jpeg(options)
            .toBuffer();
        images.qcErrorFull = files['qcError'][0].buffer.toString('base64');
    }
    if (files['mError']) {
        images.mErrorThumbnail = await sharp(files['mError'][0].buffer)
            .resize(250, 250, { fit: 'fill' })
            .jpeg(options)
            .toBuffer();
        images.mErrorFull = files['mError'][0].buffer.toString('base64');
    }
    if (files['corrected']) {
        images.correctedThumbnail = await sharp(files['corrected'][0].buffer)
            .resize(250, 250, { fit: 'fill' })
            .jpeg(options)
            .toBuffer();
        images.correctedFull = files['corrected'][0].buffer.toString('base64');
    }
    return images;
}

// Endpoint to upload images
app.post('/upload', upload.fields([{ name: 'qcError' }, { name: 'mError' }, { name: 'corrected' }]), async (req, res) => {
    try {
        console.log('Files:', req.files);
        console.log('Body:', req.body);

        const { tileNumber, errorType, errorComments, buildingNumber, useQcForAll } = req.body;
        if (!req.files['qcError']) {
            return res.status(400).send('QC error and material error images are required.');
        }

        // If 'useQcForAll' is checked and no 'mError' is provided, use 'qcError' for 'mError'
        if (useQcForAll === 'on' && !req.files['mError']) {
                  req.files['mError'] = req.files['qcError'];
        }

        const processedImages = await processImages(req.files);

        const imageData = new ImageData({
            tileNumber,
            errorComments,
            errorType,
            buildingNumber,
            thumbnails: {
                qcError: processedImages.qcErrorThumbnail.toString('base64'),
                mError: processedImages.mErrorThumbnail.toString('base64'),
                corrected: processedImages.correctedThumbnail ? processedImages.correctedThumbnail.toString('base64') : null
            },
            fullImages: {
                qcError: processedImages.qcErrorFull,
                mError: processedImages.mErrorFull,
                corrected: processedImages.correctedFull
            }
        });

        await saveWithRetry(imageData);
        res.redirect('/upload-page');
    } catch (error) {
        console.error('Failed to save image data:', error);
        res.redirect('/upload-page?success=false');
    }
});

// Retry logic for saving data
async function saveWithRetry(imageData, attempts = 5) {
    try {
        await imageData.save();
        console.log('Image saved successfully');
    } catch (error) {
        console.error('Attempt to save image failed:', error);
        if (attempts > 0) {
            console.log(`Retrying... attempts left: ${attempts - 1}`);
            await new Promise(resolve => setTimeout(resolve, 1000)); // Wait for 1 second before retrying
            await saveWithRetry(imageData, attempts - 1);
        } else {
            console.error('All retry attempts failed');
            throw error;
        }
    }
}

// Additional routes for image management and views
app.post('/approve-image/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { approvalStatus } = req.body;

        await ImageData.findByIdAndUpdate(id, { approvalStatus });
        res.redirect('/view');
    } catch (error) {
        console.error('Failed to update approval status:', error);
        res.status(500).send('Error updating approval status: ' + error.message);
    }
});

app.get('/login-protected-view', (req, res) => {
    res.render('login-protected-view');
});

app.get('/protected-view', async (req, res) => {
    const password = req.query.password;
    const correctPassword = 'vucity'; // Assume you manage this securely

    if (password !== correctPassword) {
        return res.redirect('/login-protected-view');
    }

    try {
        const images = await ImageData.find({});
        res.render('protected-view', { images });
    } catch (err) {
        console.error('Failed to fetch images:', err);
        res.status(500).send('Failed to fetch images');
    }
});

app.post('/delete-image/:id', async (req, res) => {
  const { id } = req.params;

  try {
      await ImageData.findByIdAndDelete(id);
      res.redirect('/protected-view?password=vucity');
  } catch (err) {
      console.error('Failed to delete image:', err);
      res.status(500).send('Failed to delete image'); // Correct the syntax here
  }
});


app.post('/upload-corrected/:id', upload.single('corrected'), async (req, res) => {
    const { id } = req.params;

    if (!req.file) {
        return res.status(400).send('No file uploaded.');
    }

    try {
        const correctedBuffer = await sharp(req.file.buffer).resize(250, 250).jpeg({ quality: 80 }).toBuffer();
        const correctedBase64 = correctedBuffer.toString('base64');

        await ImageData.findByIdAndUpdate(id, { 'thumbnails.corrected': correctedBase64 });
        res.redirect('/view');
    } catch (error) {
        console.error('Failed to upload corrected image:', error);
        res.status(500).send('Error uploading corrected image');
    }
});

app.get('/aql-results', async (req, res) => {
  try {
    const images = await ImageData.find({});

    // Existing aggregation for AQL results
    const results = images.reduce((acc, image) => {
      const key = image.tileNumber;
      acc[key] = acc[key] || { total: 0, errorCount: 0 };
      acc[key].total += 1;
      if (image.approvalStatus !== 'Yes') { // Count as error if not approved
        acc[key].errorCount += 1;
      }
      return acc;
    }, {});

    const aqlResults = {};
    Object.keys(results).forEach(tileNumber => {
      const { errorCount, total } = results[tileNumber];
      aqlResults[tileNumber] = {
        errorRate: (errorCount / total * 100).toFixed(2) + '%',
        errorCount: errorCount,
        totalRecords: total,
        pass: errorCount === 0  // Pass if no errors
      };
    });

    // New aggregation for Building Error Results
    const buildingResults = images.reduce((acc, image) => {
      const key = image.buildingNumber;
      acc[key] = acc[key] || { errorCount: 0 };
      if (image.approvalStatus !== 'Yes') {
        acc[key].errorCount += 1;
      }
      return acc;
    }, {});

    const buildingErrorResults = {};
    Object.keys(buildingResults).forEach(buildingNumber => {
      buildingErrorResults[buildingNumber] = {
        errorCount: buildingResults[buildingNumber].errorCount
      };
    });

    res.render('aql-results', { aqlResults, buildingErrorResults });
  } catch (err) {
    console.error('Failed to calculate AQL:', err);
    res.status(500).send('Failed to calculate AQL');
  }
});

function ensureDirectoryExists(directoryPath) {
  if (!fs.existsSync(directoryPath)) {
      fs.mkdirSync(directoryPath, { recursive: true });
  }
}

// Example AQL calculation function, updated with console.log for debugging
function calculateAQL(images) {
  let aqlResults = {};
  images.forEach(image => {
      const tile = image.tileNumber;
      if (!aqlResults[tile]) {
          aqlResults[tile] = { totalRecords: 0, initialErrors: 0, currentErrors: 0, approvedCount: 0, tileNumber: tile };
      }
      aqlResults[tile].totalRecords++;
      if (image.approvalStatus === "Yes") {
          aqlResults[tile].approvedCount++;
      } else {
          aqlResults[tile].initialErrors++;
          if (image.approvalStatus !== "Resolved") {
              aqlResults[tile].currentErrors++;
          }
      }
  });

  Object.keys(aqlResults).forEach(tile => {
      aqlResults[tile].errorCount = aqlResults[tile].currentErrors;
      const remainingErrorRate = aqlResults[tile].initialErrors > 0 ? (aqlResults[tile].currentErrors / aqlResults[tile].initialErrors * 100).toFixed(2) + '%' : '0%';
      aqlResults[tile].pass = aqlResults[tile].currentErrors === 0 ? 'Pass' : 'Fail';
  });

  console.log("AQL Results Computed:", aqlResults);
  return aqlResults;
}

function appendAQLResults(doc, aqlResults) {
  doc.addPage();
  doc.fontSize(18)
     .text('AQL Results Summary', { align: 'center' })
     .moveDown(2);

  let yPos = doc.y;

  const headers = {
      tileNumber: 'Tile Number',
      totalRecords: 'Total Records',
      errorCount: 'Error Count',
      passFail: 'Pass/Fail'
  };

  const columns = {
      tileNumber: 50,
      totalRecords: 150,
      errorCount: 250,
      passFail: 350
  };

  doc.fontSize(14)
     .text(headers.tileNumber, columns.tileNumber, yPos)
     .text(headers.totalRecords, columns.totalRecords, yPos)
     .text(headers.errorCount, columns.errorCount, yPos)
     .text(headers.errorRate, columns.errorRate, yPos)
     .text(headers.passFail, columns.passFail, yPos);

  yPos += 20;
  doc.fontSize(12);

  Object.keys(aqlResults).forEach(key => {
      const result = aqlResults[key];
      if (yPos > 700) {
          doc.addPage();
          yPos = 50;
      }

      doc.text(result.tileNumber || 'N/A', columns.tileNumber, yPos)
         .text(result.totalRecords !== undefined ? result.totalRecords.toString() : 'N/A', columns.totalRecords, yPos)
         .text(result.errorCount !== undefined ? result.errorCount.toString() : 'N/A', columns.errorCount, yPos)
         .text(result.pass || 'N/A', columns.passFail, yPos);

      yPos += 20;
  });
}



function createReportPDF(images, aqlResults, callback) {
  const reportsDir = path.join(__dirname, 'public', 'reports');
  ensureDirectoryExists(reportsDir);
  const fileName = path.join(reportsDir, `report-${Date.now()}.pdf`);
  const stream = fs.createWriteStream(fileName);

  const doc = new PDFDocument({ margin: 20 });
  doc.pipe(stream);

  doc.fontSize(12);
  let yPosition = 40; // Start position for the first record

  if (!images.length) {
      doc.text('No images available for report.');
  } else {
      images.forEach((image, index) => {
          if (index % 6 === 0) {
              if (index !== 0) {
                  doc.addPage();
              }
              setTableHeaders(doc);
              yPosition = 80;
          }

          appendRecord(doc, image, yPosition);
          yPosition += 110;
      });
  }

  appendAQLResults(doc, aqlResults);  // Verify this call inside a condition to ensure data exists

  doc.end();

  stream.on('finish', () => {
      console.log("PDF Generated at", fileName);
      callback(null, fileName);
  });

  stream.on('error', (err) => {
      console.error("Error during PDF generation:", err);
      callback(err, null);
  });
}


// Helper function to set table headers
function setTableHeaders(doc) {
  doc.text('Tile Number', 20, 50, { width: 100, align: 'center' })
     .text('Building Number', 120, 50, { width: 100, align: 'center' })
     .text('Status', 220, 50, { width: 100, align: 'center' })
     .text('QC Error', 320, 50, { width: 100, align: 'center' })
     .text('MError', 420, 50, { width: 100, align: 'center' })
     .text('Corrected', 520, 50, { width: 100, align: 'center' });
}

// Helper function to append each record
function appendRecord(doc, image, yPosition) {
  doc.text(image.tileNumber, 20, yPosition, { width: 100, align: 'center' })
     .text(image.buildingNumber, 120, yPosition, { width: 100, align: 'center' })
     .text(image.approvalStatus, 220, yPosition, { width: 100, align: 'center' });

  if (image.thumbnails.qcError) {
      doc.image(Buffer.from(image.thumbnails.qcError, 'base64'), 320, yPosition - 15, { width: 100, height: 100 });
  }
  if (image.thumbnails.mError) {
      doc.image(Buffer.from(image.thumbnails.mError, 'base64'), 420, yPosition - 15, { width: 100, height: 100 });
  }
  if (image.thumbnails.corrected) {
      doc.image(Buffer.from(image.thumbnails.corrected, 'base64'), 520, yPosition - 15, { width: 100, height: 100 });
  }
}

// Generate report endpoint
app.get('/generate-report', async (req, res) => {
  try {
      const images = await ImageData.find({});
      console.log(images);  // Check if images are retrieved
      if (!images.length) {
          return res.status(404).send('No images found');
      }
      const aqlResults = calculateAQL(images);
      createReportPDF(images, aqlResults, (err, filePath) => {
          if (err) {
              console.error('Error generating report:', err);
              return res.status(500).send('Error generating report');
          }
          res.download(filePath, (err) => {
              if (err) {
                  console.error('Error during file download:', err);
                  return res.status(500).send('Error downloading file');
              }
              fs.unlink(filePath, (deleteErr) => {
                  if (deleteErr) console.error('Error deleting file:', deleteErr);
              });
          });
      });
  } catch (err) {
      console.error('Failed to fetch data for report:', err);
      res.status(500).send('Failed to fetch data for report');
  }
});



app.get('/view', async (req, res) => {
  const perPage = 30;
  const page = req.query.page || 1;

  try {
      const query = {};
      if (req.query.tileNumber) {
          query.tileNumber = req.query.tileNumber;
      }
      if (req.query.errorType) {
          query.errorType = req.query.errorType;
      }
      if (req.query.buildingNumber) {
          query.buildingNumber = req.query.buildingNumber;
      }
      if (req.query.approvalStatus) {
          query.approvalStatus = req.query.approvalStatus;
      }

      const images = await ImageData.find(query)
                                    .skip((perPage * page) - perPage)
                                    .limit(perPage);

      const count = await ImageData.countDocuments(query);

      res.render('view', {
          images: images,
          current: page,
          pages: Math.ceil(count / perPage),
          filters: req.query
      });
  } catch (error) {
      res.status(500).send('Failed to fetch images: ' + error.message);
  }
});


app.get('/upload-page', (req, res) => {
    res.render('upload-page');
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
    console.log(`Server running on port ${port}`);
});
