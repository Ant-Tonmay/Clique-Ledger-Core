import { Router, Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import generateCliqueId from '../controllers/generateCliqueId';
import generateMemberId from '../controllers/generateMemberId';
import { auth } from 'express-oauth2-jwt-bearer';
import checkIdentity from '../middlewares/checkIdentity';
import checkCliqueLevelPerms from '../middlewares/checkCliqueLevelPerms';

import { io } from '../app';
import * as z from 'zod';
import generateMediaId from '../controllers/generateMediaId';
import { uploadSingleFileHelper } from '../controllers/multer_helper';

const prisma = new PrismaClient()

const router = Router();
const checkJwt = auth();

// get all cliques
router.get('/', checkJwt, checkIdentity, async (req: Request, res: Response) => {
  try {

  const userId = res.locals.user.user_id;
  const allRecords = await prisma.clique.findMany({
    where: {
      members: {
        some: {
          user_id: userId,
          is_active: true,
        }
      }
    },
    include: {
      members: {
        where: {
          is_active: true,
        },
        include: {
          user: {
            select: {
              user_id: true,
              user_name: true,
              mail: true,
            }
          }
        }
      },
      transactions: {
        orderBy: {
          done_at: 'desc',
        },
        take: 1, // Get only the latest transaction
      }
    }
  });

    if (allRecords.length === 0) {
      console.log("No data");
      res.status(200).json("No data found");
      return;
    }

    const transformedRecords = allRecords.map(clique => ({
      clique_id: clique.clique_id,
      clique_name: clique.clique_name,
      members: clique.members
      .filter(member => member.is_active)
      .map(member => ({
        user_id: member.user_id,
        member_id: member.member_id,
        member_name: member.user.user_name,
        email: member.user.mail,
        is_admin: member.is_admin,
      })),
      is_fund: clique.is_fund,
      fund: clique.fund,
      isActive: clique.is_active,
      last_transaction: clique.transactions.length > 0 ? {
        transaction_id: clique.transactions[0].transaction_id,
        clique_id: clique.clique_id,
        transaction_type: clique.transactions[0].transaction_type,
        amount: clique.transactions[0].amount,
        description: clique.transactions[0].description,
        sender_id: clique.transactions[0].sender_id,
        is_verified: clique.transactions[0].is_verified,
        done_at: clique.transactions[0].done_at,
      } : null
    }));

    res.status(200).json(transformedRecords);
  } catch (err) {
    console.log(err);
    res.status(500).json({ error: "An error occurred while fetching records" });
  }
});

// create a new clique and return
router.post('/', checkJwt, checkIdentity, async (req: Request, res: Response) => {
  try {
    const name: string = req.body.name;
    const funds: number = parseFloat(req.body.funds);
    const fund_flag: boolean = funds !== 0;

    // Create new clique
    const newCliqueId = await generateCliqueId();
    const newClique = await prisma.clique.create({
      data: {
        clique_id: newCliqueId,
        fund: funds,
        is_fund: fund_flag,
        clique_name: name,
      }
    });

    const newMember = await prisma.member.create({
      data: {
        member_id: await generateMemberId(),
        user_id: res.locals.user.user_id as string,
        clique_id: newClique.clique_id,
        is_admin: true,
        joined_at: new Date(),
      }
    });
    
    await prisma.ledger.create({
      data:{
        member_id: newMember.member_id,
        clique_id: newMember.clique_id,
        amount: 0,
        is_due: false
      }
    });
    
    const transformedClique = {
      clique_id: newClique.clique_id,
      clique_name: newClique.clique_name,
      members: {
        user_id: newMember.user_id,
        member_id: newMember.member_id,
        member_name: res.locals.user.user_name,
        email: res.locals.user.user_email,
        is_admin: true,
      },
      isFund: newClique.is_fund,
      fund: newClique.fund,
      isActive: newClique.is_active
    };

    res.status(201).json(transformedClique);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'An error occurred while creating the clique' });
  }
});

// GET a single clique by ID
router.get('/:cliqueId', async (req: Request, res: Response) => {
  try {
    const cliqueId: string = req.params.cliqueId;

    const clique = await prisma.clique.findUnique({
      where: {
        clique_id: cliqueId,
      },
      include: {
        members: {
          where: {
            is_active: true
          },
          include: {
            user: {
              select: {
                user_id: true,
                user_name: true,
                mail: true,
              }
            }
          }
        }
      },
    });

    if (!clique) {
      res.status(404).json({ message: 'Clique not found' });
      return;
    }

    const transformedClique = {
      clique_id: clique.clique_id,
      clique_name: clique.clique_name,
      members: clique.members
      .filter(member => member.is_active)
      .map(member => ({
        user_id: member.user_id,
        member_id: member.member_id,
        member_name: member.user.user_name,
        email: member.user.mail,
        is_admin: member.is_admin,
      })),
      isFund: clique.is_fund,
      fund: clique.fund,
      isActive: clique.is_active
    };

    res.status(200).json(transformedClique);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'An error occurred while fetching the clique' });
  }
});

// Update clique name using clique id
router.patch('/:cliqueId', checkJwt, checkIdentity,checkCliqueLevelPerms(":/cliqueId", "member"),  async (req: Request, res: Response) => {
  try {
    const cliqueId: string = req.params.cliqueId;
    const name: string = req.body.name;

    const existingClique = await prisma.clique.findUnique({
      where: {
        clique_id: cliqueId,
      },
    });

    if (!existingClique) {
      return res.status(404).json({ field_name: 'name', status: 'NOT FOUND' });
    }

    // Perform partial update if name is provided
    if (name) {
      await prisma.clique.update({
        where: {
          clique_id: cliqueId,
        },
        data: {
          clique_name: name,
        },
      });
    }

    return res.status(200).json({ field_name: 'name', status: 'SUCCESS' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'An error occurred while updating the clique' });
  }
});

// Delete a clique using clique id
router.delete('/:cliqueId', checkJwt, checkIdentity, checkCliqueLevelPerms(":/cliqueId", "admin"), async (req: Request, res: Response) => {
  try {
    const cliqueId: string = req.params.cliqueId;

    const deletedClique = await prisma.clique.delete({
      where: {
        clique_id: cliqueId,
      },
    });

    if (!deletedClique) {
      res.status(404).json({ field_name: 'cliqueId', status: 'NOT FOUND' });
      return;
    }

    // Delete all associated transactions
    await prisma.transaction.deleteMany({
      where: {
        clique_id: cliqueId,
      },
    });

    res.status(204).json({ message: 'Clique deleted successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'An error occurred while deleting the clique' });
    return;
  }
});

//add members in a clique
router.post('/:cliqueId/members/', checkJwt, checkIdentity, checkCliqueLevelPerms(":/cliqueId", "admin"), async (req: Request, res: Response) => {
  try {
    const cliqueId: string = req.params.cliqueId;
    const userIds: string[] = req.body;

    // Check if userIds is an array
    if (!Array.isArray(userIds)) {
      res.status(400).json({
        status: 'FAILURE',
        message: 'Invalid input format. Expected an array of user IDs.',
      });
      return;
    }

    // Initialize an array to store the new members
    const newMembers = [];

    // Loop through the user IDs and add each to the clique
    for (const userId of userIds) {
      // Fetch the user details to verify existence
      const user = await prisma.user.findUnique({
        where: { user_id: userId },
        select: { user_id: true, user_name: true, mail: true },
      });

      if (user) {
        const newMemberId = await generateMemberId();
        const checkMember = await prisma.member.findFirst({
          where: {
            user_id: userId,
            clique_id: cliqueId,
          },
        })

        if(checkMember){
        if(checkMember.is_active == true){
          res.status(409).json({
            status: 'FAILURE',
            message: `User with email id: ${user.mail} already exists in the clique`,
          });
          return;
        }
        else{
          await prisma.member.update({
            data: {
              is_active: true,
            },
            where: {
              member_id: checkMember.member_id,
            },
          });
          res.status(201).json({
            status: 'SUCCESS',
            message: 'Members added successfully',
            data: newMembers,
          });
          return;
        }
      }
        // Create the new member
        const newMember = await prisma.member.create({
          data: {
            member_id: newMemberId,
            user_id: userId,
            clique_id: cliqueId,
            is_admin: false,
            joined_at: new Date(),
          },
        });

        await prisma.ledger.create({
          data:{
            member_id: newMember.member_id,
            clique_id: newMember.clique_id,
            amount: 0,
            is_due: false
          }
        });

        newMembers.push({
          member_id: newMember.member_id,
          user_id: newMember.user_id,
          clique_id: newMember.clique_id,
          is_admin: newMember.is_admin,
          joined_at: newMember.joined_at,
          member_name: user.user_name,
          email: user.mail,
        });
      }
      else {
        res.status(404).json({
          status: 'FAILURE',
          message: `User with user_id ${userId} not found`,
        });
        return;
      }
    }

    if (newMembers.length === 0) {
      res.status(404).json({
        status: 'FAILURE',
        message: 'No valid users found to add to the clique.',
      });
      return;
    }

    res.status(201).json({
      status: 'SUCCESS',
      message: 'Members added successfully',
      data: newMembers,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ status: 'FAILURE', message: 'An error occurred while adding members' });
  }
});


// remove a member
router.delete('/:cliqueId/members/', checkJwt, checkIdentity, checkCliqueLevelPerms(":/cliqueId", "admin"), async (req: Request, res: Response) => {
  try {
    const userIds: string[] = req.body;

    // Check if userIds is an array
    if (!Array.isArray(userIds)) {
      res.status(400).json({
        status: 'FAILURE',
        message: 'Invalid input format. Expected an array of user IDs.',
      });
      return;
    }

    for (const userId of userIds) {
      await prisma.member.update({
        data: { is_active: false },
        where: { member_id: userId },
      });
    }
    res.status(204).json({
      status: 'SUCCESS',
      message: 'Members removed successfully',
    });
  } catch (err) {
    console.log(err);
    res.status(500).json({ status: 'FAILURE', message: 'An error occurred while removing members' });
  }
});

router.get(
  '/:cliqueId/media',
  checkJwt,
  checkIdentity,
  checkCliqueLevelPerms(':/cliqueId', 'member'),
  async (req: Request, res: Response) => {
    const paramSchema = z.object({
      cliqueId: z.string()
    });
    
    let params;
    try{
      params = paramSchema.parse(req.params);
    } catch(err) {
      console.log(err);
      res.status(400).json({
        message: "Invalid cliqueId provided or it is missing"
      });
      return;
    }
    const media = await prisma.media.findMany({
      where: {
        clique_id: params.cliqueId 
      }
    });

    res.status(200).json(media);
  }
);

router.post(
  '/:cliqueId/media/',
  checkJwt,
  checkIdentity,
  checkCliqueLevelPerms(':/cliqueId', 'member'),
  uploadSingleFileHelper('file'),
  async(req: Request, res: Response) => {

    const cliqueId = req.params.cliqueId;
    console.log(req.file);
    if(!req.file) {
      res.status(400).json({
        message: "No file was provided!!"
      });
      return;
    }
    
    const fileResponseSchema = z.object({
      mimetype: z.string(),
      location: z.string(),
    }).catchall(z.unknown());

    let parsedFile;
    try{
      parsedFile = fileResponseSchema.parse(req.file);
    } catch(err) {
      console.log("S3 multer::File parsing error ");
      console.log(err);
      res.status(500).json({
        message: "File was not uploaded ! Please retry after a moment !"
      });
      return;
    }
    
    
    try{
    console.log('user--', res.locals.member.member_id);
    const media = await prisma.media.create({
      data: {
        media_id: await generateMediaId(),
        clique_id: cliqueId,
        file_url: parsedFile.location,
        media_type: parsedFile.mimetype,
        sender_id: res.locals.member.member_id
      }
    });

    io.to(cliqueId).emit('media-created', {
      ...media
    });
    res.status(201).json(media);
    return;
  } catch(err) {
    console.log(err);
    res.status(500).send("Database error")
  }
  });

  

export default router;