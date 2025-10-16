// File: print-server.js
import axios from 'axios';
import { ThermalPrinter, PrinterTypes } from 'node-thermal-printer';
import 'dotenv/config';

// --- Configuration ---
const config = {
    apiUrl: process.env.CLOUD_API_URL,
    adminToken: process.env.ADMIN_JWT_TOKEN,
    pollInterval: parseInt(process.env.POLL_INTERVAL, 10) || 10000,
};

// Create an Axios instance for authenticated requests
const api = axios.create({
    baseURL: config.apiUrl,
    headers: {
        'Authorization': `Bearer ${config.adminToken}`,
    },
});

// --- Printer Setup ---
// This setup is for a generic USB ESC/POS printer.
// You might need to adjust this based on your printer's connection type.
let printer = new ThermalPrinter({
    type: PrinterTypes.EPSON, // Printer type, EPSON is a common standard
    interface: 'printer:EPSON TM-T20II', // The name of your printer driver. Find this in your OS's printer settings. Or use 'usb' for direct connection.
    characterSet: 'SLOVENIA', // Or 'INDIA' if available, for rupee symbol support
    removeSpecialCharacters: false,
    lineCharacter: "=",
    options:{
      timeout: 5000
    }
});

// --- Main Functionality ---

async function formatAndPrintReceipt(order) {
    console.log(`Formatting receipt for Order #${order.id}...`);

    printer.alignCenter();
    printer.bold(true);
    printer.println("Al-Makhmali");
    printer.bold(false);
    printer.println("New Order Received!");
    printer.println(new Date(order.created_at).toLocaleString('en-IN'));
    printer.drawLine();

    printer.alignLeft();
    printer.println(`Order ID: #${order.id}`);
    printer.println(`Customer: ${order.customer_name}`);
    printer.println(`Phone: ${order.phone}`);
    printer.println(`Address: ${order.address_line1}, ${order.area}, ${order.city}`);
    printer.drawLine();

    printer.bold(true);
    printer.println("Items:");
    printer.bold(false);
    order.items.forEach(item => {
        const price = `Rs. ${item.price.toFixed(2)}`;
        printer.tableCustom([
            { text: `${item.qty}x ${item.name}`, align: "LEFT", width: 0.7 },
            { text: price, align: "RIGHT", width: 0.3 }
        ]);
    });
    printer.drawLine();
    
    // Add totals
    printer.tableCustom([
        { text: `Subtotal`, align: "LEFT", width: 0.7 },
        { text: `Rs. ${order.subtotal.toFixed(2)}`, align: "RIGHT", width: 0.3 }
    ]);
    // ... add delivery, platform fee, discount if needed

    printer.bold(true);
    printer.tableCustom([
        { text: `TOTAL`, align: "LEFT", width: 0.7, bold: true },
        { text: `Rs. ${order.grand_total.toFixed(2)}`, align: "RIGHT", width: 0.3, bold: true }
    ]);
    printer.bold(false);
    
    printer.println(`Payment: ${order.pay_method.toUpperCase()}`);
    if (order.pay_method === 'cod') {
        printer.bold(true);
        printer.println(`Collect: Rs. ${order.grand_total.toFixed(2)}`);
        printer.bold(false);
    }

    printer.cut();

    try {
        await printer.execute();
        console.log(`Successfully printed Order #${order.id}.`);
        return true;
    } catch (error) {
        console.error("Print failed:", error);
        return false;
    }
}


async function pollAndPrint() {
    console.log("Checking for new orders to print...");
    try {
        const { data: ordersToPrint } = await api.get('/admin/print-queue');

        if (ordersToPrint.length === 0) {
            console.log("No new orders found.");
            return;
        }

        console.log(`Found ${ordersToPrint.length} new order(s).`);
        
        for (const order of ordersToPrint) {
            const success = await formatAndPrintReceipt(order);
            if (success) {
                // If printing was successful, confirm it with the cloud server
                await api.post(`/admin/print-queue/confirm/${order.id}`);
                console.log(`Confirmed printing for Order #${order.id}.`);
            } else {
                console.error(`Skipping confirmation for failed print of Order #${order.id}. It will be retried on the next poll.`);
            }
        }
    } catch (error) {
        console.error("Error polling for orders:", error.response?.data || error.message);
    }
}

// --- Start the process ---
console.log("Starting Makhmali Print Server...");
console.log(`Will check for new orders every ${config.pollInterval / 1000} seconds.`);

// Run once immediately, then start the interval
pollAndPrint();
setInterval(pollAndPrint, config.pollInterval);