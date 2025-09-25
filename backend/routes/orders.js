const express = require('express');
const { body, validationResult, query } = require('express-validator');
const { PrismaClient } = require('@prisma/client');
const { auth } = require('../middleware/auth');

const router = express.Router();
const prisma = new PrismaClient();

// Get user's orders
router.get('/', auth, [
  query('page').optional().isInt({ min: 1 }).withMessage('Page must be a positive integer'),
  query('limit').optional().isInt({ min: 1, max: 50 }).withMessage('Limit must be between 1 and 50')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const skip = (page - 1) * limit;

    const [orders, total] = await Promise.all([
      prisma.order.findMany({
        where: { userId: req.user.id },
        include: {
          orderItems: {
            include: {
              product: {
                select: {
                  id: true,
                  name: true,
                  imageUrl: true
                }
              }
            }
          }
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit
      }),
      prisma.order.count({
        where: { userId: req.user.id }
      })
    ]);

    const totalPages = Math.ceil(total / limit);

    res.json({
      orders,
      pagination: {
        currentPage: page,
        totalPages,
        totalOrders: total,
        hasNext: page < totalPages,
        hasPrev: page > 1
      }
    });
  } catch (error) {
    console.error('Get orders error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Get single order
router.get('/:id', auth, async (req, res) => {
  try {
    const orderId = parseInt(req.params.id);
    
    if (isNaN(orderId)) {
      return res.status(400).json({ message: 'Invalid order ID' });
    }

    const order = await prisma.order.findFirst({
      where: {
        id: orderId,
        userId: req.user.id
      },
      include: {
        orderItems: {
          include: {
            product: {
              select: {
                id: true,
                name: true,
                imageUrl: true,
                description: true
              }
            }
          }
        }
      }
    });

    if (!order) {
      return res.status(404).json({ message: 'Order not found' });
    }

    res.json({ order });
  } catch (error) {
    console.error('Get order error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Create order
router.post('/', auth, [
  body('items').isArray({ min: 1 }).withMessage('Order must contain at least one item'),
  body('items.*.productId').isInt({ min: 1 }).withMessage('Product ID must be a positive integer'),
  body('items.*.quantity').isInt({ min: 1 }).withMessage('Quantity must be a positive integer')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { items } = req.body;

    // Start transaction
    const result = await prisma.$transaction(async (prisma) => {
      // Validate products and check stock
      const productIds = items.map(item => item.productId);
      const products = await prisma.product.findMany({
        where: { id: { in: productIds } }
      });

      if (products.length !== productIds.length) {
        throw new Error('Some products not found');
      }

      // Check stock and calculate total
      let totalAmount = 0;
      const orderItemsData = [];

      for (const item of items) {
        const product = products.find(p => p.id === item.productId);
        
        if (product.stock < item.quantity) {
          throw new Error(`Insufficient stock for product: ${product.name}`);
        }

        const itemTotal = product.price * item.quantity;
        totalAmount += itemTotal;

        orderItemsData.push({
          productId: item.productId,
          quantity: item.quantity,
          price: product.price
        });

        // Update product stock
        await prisma.product.update({
          where: { id: item.productId },
          data: { stock: { decrement: item.quantity } }
        });
      }

      // Create order
      const order = await prisma.order.create({
        data: {
          userId: req.user.id,
          totalAmount,
          status: 'PENDING',
          orderItems: {
            create: orderItemsData
          }
        },
        include: {
          orderItems: {
            include: {
              product: {
                select: {
                  id: true,
                  name: true,
                  imageUrl: true
                }
              }
            }
          }
        }
      });

      return order;
    });

    res.status(201).json({
      message: 'Order created successfully',
      order: result
    });
  } catch (error) {
    console.error('Create order error:', error);
    
    if (error.message.includes('Insufficient stock') || error.message.includes('not found')) {
      return res.status(400).json({ message: error.message });
    }
    
    res.status(500).json({ message: 'Server error' });
  }
});

// Update order status (for payment confirmation)
router.put('/:id/status', auth, [
  body('status').isIn(['PENDING', 'PROCESSING', 'SHIPPED', 'DELIVERED', 'CANCELLED'])
    .withMessage('Invalid status')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const orderId = parseInt(req.params.id);
    const { status } = req.body;
    
    if (isNaN(orderId)) {
      return res.status(400).json({ message: 'Invalid order ID' });
    }

    // Check if order belongs to user
    const existingOrder = await prisma.order.findFirst({
      where: {
        id: orderId,
        userId: req.user.id
      }
    });

    if (!existingOrder) {
      return res.status(404).json({ message: 'Order not found' });
    }

    // Users can only cancel pending orders
    if (req.user.role !== 'ADMIN' && status !== 'CANCELLED') {
      return res.status(403).json({ message: 'Unauthorized to update order status' });
    }

    if (req.user.role !== 'ADMIN' && existingOrder.status !== 'PENDING') {
      return res.status(400).json({ message: 'Can only cancel pending orders' });
    }

    const order = await prisma.order.update({
      where: { id: orderId },
      data: { status },
      include: {
        orderItems: {
          include: {
            product: {
              select: {
                id: true,
                name: true,
                image: true
              }
            }
          }
        }
      }
    });

    // If order is cancelled, restore stock
    if (status === 'CANCELLED') {
      await prisma.$transaction(async (prisma) => {
        for (const item of order.orderItems) {
          await prisma.product.update({
            where: { id: item.productId },
            data: { stock: { increment: item.quantity } }
          });
        }
      });
    }

    res.json({
      message: 'Order status updated successfully',
      order
    });
  } catch (error) {
    console.error('Update order status error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Cancel order
router.delete('/:id', auth, async (req, res) => {
  try {
    const orderId = parseInt(req.params.id);
    
    if (isNaN(orderId)) {
      return res.status(400).json({ message: 'Invalid order ID' });
    }

    const order = await prisma.order.findFirst({
      where: {
        id: orderId,
        userId: req.user.id
      },
      include: {
        orderItems: true
      }
    });

    if (!order) {
      return res.status(404).json({ message: 'Order not found' });
    }

    if (order.status !== 'PENDING') {
      return res.status(400).json({ message: 'Can only cancel pending orders' });
    }

    // Cancel order and restore stock
    await prisma.$transaction(async (prisma) => {
      // Update order status
      await prisma.order.update({
        where: { id: orderId },
        data: { status: 'CANCELLED' }
      });

      // Restore stock
      for (const item of order.orderItems) {
        await prisma.product.update({
          where: { id: item.productId },
          data: { stock: { increment: item.quantity } }
        });
      }
    });

    res.json({ message: 'Order cancelled successfully' });
  } catch (error) {
    console.error('Cancel order error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;
